# sapi-recognizer.ps1
# Windows 语音识别子进程（日程侧边栏 语音输入）—— waveIn 采集 + SAPI 流喂版
#
# 背景：SAPI 默认音频路径（SetInputToDefaultAudioDevice）在本机增益异常：
#       设备层实测峰值 ~30%，但 SAPI 引擎内只收到 ~1%（AudioLevel=1，报 TooSoft），识别不可用；
#       而 waveIn 同设备实测峰值 ~12-20% 正常。故绕开 SAPI 音频路径：
#       WinMM waveIn 采集 16k/16bit/单声道 → VAD 判停 → 3 倍增益 → SAPI SetInputToAudioStream 识别。
#
# 协议（与主进程 main.js 约定，保持不变）：
#   stdin  'start' 开始监听（采集至说话结束：静默 0.9s 判停，最长 10s；6s 无语音则本轮无结果）
#          'stop'  停止监听；本轮未听到任何结果时回发 listen_done（并中断采集）
#          'exit'  退出
#   stdout 每行一个 JSON：
#     {"event":"ready"}                     引擎就绪（此时未占用麦克风）
#     {"event":"recognized","text":...}     识别到一个短句（一句即止，主进程同时会发 stop）
#     {"event":"listen_done"}               本轮监听无结果（静默超时/取消/采集失败）
#     {"event":"fatal","error":...}         引擎初始化失败，进程将退出
#
# 架构：stdin 用 BeginRead 异步收指令 + 主循环轮询；监听时阻塞采集+识别（指令最多延迟一轮，
# 取消场景可接受）；进程常驻，随主进程退出或 stdin 关闭而退出。
param([string]$Lang)
if ([string]::IsNullOrEmpty($Lang)) { $Lang = 'zh-CN' }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
function Send-Line {
  param([string]$Json)
  [Console]::Out.WriteLine($Json)
  [Console]::Out.Flush()
}
function Esc {
  param([string]$s)
  return ($s -replace '\\','\\' -replace '"','\"' -replace "`r"," " -replace "`n"," ")
}

$cs = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class WavCapture
{
    public static bool CancelFlag = false;
    public static string LastStep = "entry";

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);

    const int RATE = 16000;

    // 采集至说话结束：VAD 静默判停 + 增益 + 掐头；返回 16k/16bit/mono PCM
    // maxMs 最长采集时长；threshold 语音判定阈值（int16 峰值）；gain 增益倍数
    // info: OK / NOSPEECH / CANCELLED / FAIL
    public static byte[] CaptureVAD(int maxMs, int threshold, double gain, ref string info, ref string err)
    {
        info = "OK"; err = null;
        CancelFlag = false;
        try
        {
            WAVEFORMATEX fmt = new WAVEFORMATEX();
            fmt.wFormatTag = 1; // PCM
            fmt.nChannels = 1;
            fmt.nSamplesPerSec = RATE;
            fmt.wBitsPerSample = 16;
            fmt.nBlockAlign = 2;
            fmt.nAvgBytesPerSec = 32000;
            fmt.cbSize = 0;

            LastStep = "waveInOpen";
            IntPtr h;
            int hr = waveInOpen(out h, 0xFFFFFFFFu /*WAVE_MAPPER=默认录音设备*/, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
            if (hr != 0) { info = "FAIL"; err = "waveInOpen err=" + hr; return null; }

            LastStep = "prepare";
            int bufMs = 300;
            int bufBytes = 32000 * bufMs / 1000;
            int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
            IntPtr[] data = new IntPtr[3];
            IntPtr[] hdrs = new IntPtr[3];
            for (int i = 0; i < 3; i++)
            {
                data[i] = Marshal.AllocHGlobal(bufBytes);
                WAVEHDR wh = new WAVEHDR();
                wh.lpData = data[i];
                wh.dwBufferLength = (uint)bufBytes;
                hdrs[i] = Marshal.AllocHGlobal(hdrSize);
                Marshal.StructureToPtr(wh, hdrs[i], false);
                waveInPrepareHeader(h, hdrs[i], hdrSize);
            }
            for (int i = 0; i < 3; i++) waveInAddBuffer(h, hdrs[i], hdrSize);
            LastStep = "Start";
            waveInStart(h);

            System.Collections.Generic.List<byte[]> chunks = new System.Collections.Generic.List<byte[]>();
            int speechChunks = 0;      // 含语音的 chunk 计数
            int quietAfterSpeech = 0;  // 开口后的连续静音 chunk 计数
            int startIdx = -1;         // 语音起始 chunk（保留前一 chunk 作掐头余量）
            DateTime t0 = DateTime.UtcNow;

            while (DateTime.UtcNow.Subtract(t0).TotalMilliseconds < maxMs)
            {
                if (CancelFlag) { if (speechChunks == 0) info = "CANCELLED"; break; }
                bool gotAny = false;
                for (int i = 0; i < 3; i++)
                {
                    WAVEHDR wh = (WAVEHDR)Marshal.PtrToStructure(hdrs[i], typeof(WAVEHDR));
                    if ((wh.dwFlags & 1) == 0) continue; // WHDR_DONE
                    gotAny = true;
                    int got = (int)wh.dwBytesRecorded;
                    byte[] chunk;
                    if (got > 0) { chunk = new byte[got]; Marshal.Copy(wh.lpData, chunk, 0, got); }
                    else { chunk = new byte[bufBytes]; } // 静音帧补零
                    int pk = 0;
                    for (int b = 0; b + 1 < chunk.Length; b += 2)
                    {
                        short v = (short)(chunk[b] | (chunk[b + 1] << 8));
                        int a = v < 0 ? -v : v;
                        if (a > pk) pk = a;
                    }
                    chunks.Add(chunk);
                    if (pk >= threshold)
                    {
                        if (startIdx < 0) startIdx = Math.Max(0, chunks.Count - 2);
                        speechChunks++;
                        quietAfterSpeech = 0;
                    }
                    else if (speechChunks > 0) { quietAfterSpeech++; }
                    // 重新入队继续采集
                    LastStep = "requeue";
                    waveInUnprepareHeader(h, hdrs[i], hdrSize);
                    wh.dwFlags = 0;
                    wh.dwBytesRecorded = 0;
                    Marshal.StructureToPtr(wh, hdrs[i], false);
                    waveInPrepareHeader(h, hdrs[i], hdrSize);
                    waveInAddBuffer(h, hdrs[i], hdrSize);
                }
                if (speechChunks > 0 && quietAfterSpeech >= 3) break; // 0.9s 静默判停
                if (!gotAny) Thread.Sleep(20);
                if (speechChunks == 0 && DateTime.UtcNow.Subtract(t0).TotalMilliseconds > 6000)
                {
                    info = "NOSPEECH"; // 6 秒前置静默，本轮无语音
                    break;
                }
            }

            LastStep = "stop";
            waveInStop(h);
            waveInReset(h);
            for (int i = 0; i < 3; i++) waveInUnprepareHeader(h, hdrs[i], hdrSize);
            waveInClose(h);
            for (int i = 0; i < 3; i++) { Marshal.FreeHGlobal(data[i]); Marshal.FreeHGlobal(hdrs[i]); }

            if (speechChunks == 0) return null; // NOSPEECH / CANCELLED 无语音
            // 拼接（掐掉语音前的静音）并施加增益
            int first = startIdx < 0 ? 0 : startIdx;
            int total = 0;
            for (int i = first; i < chunks.Count; i++) total += chunks[i].Length;
            byte[] outB = new byte[total];
            int w = 0;
            for (int i = first; i < chunks.Count; i++)
            {
                byte[] c = chunks[i];
                for (int b = 0; b + 1 < c.Length; b += 2)
                {
                    int v = (short)(c[b] | (c[b + 1] << 8));
                    v = (int)Math.Round(v * gain);
                    if (v > 32767) v = 32767;
                    if (v < -32768) v = -32768;
                    short sv = (short)v;
                    outB[w++] = (byte)(sv & 0xFF);
                    outB[w++] = (byte)((sv >> 8) & 0xFF);
                }
            }
            return outB;
        }
        catch (Exception ex)
        {
            info = "FAIL";
            err = "[" + LastStep + "] " + ex.Message;
            return null;
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $cs -Language CSharp
  Add-Type -AssemblyName System.Speech
  $all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $ri = $null
  $names = ''
  foreach ($r in $all) {
    if ($names) { $names += ',' }
    $names += $r.Culture.Name
    if ($r.Culture.Name -eq $Lang -and -not $ri) { $ri = $r }
  }
  if (-not $ri) {
    Send-Line ('{"event":"fatal","isFinal":true,"error":"No recognizer for ' + (Esc $Lang) + ' (available: ' + (Esc $names) + ')"}')
    return
  }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ri)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  Send-Line '{"event":"ready"}'

  $script:listening = $false
  $script:gotResult = $false
  $stdin = [Console]::OpenStandardInput()
  $buf = New-Object byte[] 256
  $pending = $stdin.BeginRead($buf, 0, 256, $null, $null)
  $quit = $false

  while (-not $quit) {
    # stdin 指令处理（异步读完成即处理；采集+识别阻塞期间指令最多延迟一轮，取消场景可接受）
    if ($pending.IsCompleted) {
      $n = $stdin.EndRead($pending)
      if ($n -le 0) { break }   # stdin 关闭（主进程退出）→ 清理退出
      $text = [Text.Encoding]::UTF8.GetString($buf, 0, $n)
      foreach ($line in ($text -split "`r?`n")) {
        $line = $line.Trim()
        if ($line -eq 'start') {
          $script:listening = $true
          $script:gotResult = $false
        } elseif ($line -eq 'stop') {
          [WavCapture]::CancelFlag = $true   # 中断进行中的采集（VAD 提前结束）
          # 仍在监听且尚无结果 → 本轮以 listen_done 收尾（取消场景）
          if ($script:listening -and -not $script:gotResult) {
            Send-Line '{"event":"listen_done"}'
          }
          $script:listening = $false
        } elseif ($line -eq 'exit') {
          $quit = $true
        }
      }
      if (-not $quit) { $pending = $stdin.BeginRead($buf, 0, 256, $null, $null) }
      continue
    }
    if ($script:listening) {
      # 阻塞采集：VAD 判停（静默 0.9s / 最长 10s / 6s 无语音）→ 增益 → 流喂识别
      $info = ''; $err = ''
      $pcm = [WavCapture]::CaptureVAD(10000, 1000, 3.0, [ref]$info, [ref]$err)
      if ($script:listening) {
        # 未被取消：本轮必须发出恰好一个终结事件（recognized XOR listen_done）
        if ($pcm) {
          $stm = New-Object IO.MemoryStream(,$pcm)
          $afi = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
          $engine.SetInputToAudioStream($stm, $afi)
          $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(10)
          $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(1)
          $engine.BabbleTimeout = [TimeSpan]::FromSeconds(0)
          $r = $engine.Recognize()
          if ($r -and $r.Text) {
            $script:gotResult = $true
            Send-Line ('{"event":"recognized","text":"' + (Esc $r.Text) + '","isFinal":true,"confidence":' + [Math]::Round($r.Confidence, 3) + '}')
          } else {
            Send-Line '{"event":"listen_done"}'   # 引擎未识别出内容
          }
        } else {
          Send-Line '{"event":"listen_done"}'     # NOSPEECH / CANCELLED 无语音 / 采集失败
        }
        $script:listening = $false
      }
      # 被取消（stop 处理器已回发 listen_done）：此处不再发事件
      continue
    }
    Start-Sleep -Milliseconds 60
  }
  $engine.Dispose()
} catch {
  $msg = $_.Exception.Message -replace '\\','\\' -replace '"','\"' -replace "`r"," " -replace "`n"," "
  Send-Line ('{"event":"fatal","isFinal":true,"error":"' + $msg + '"}')
}
