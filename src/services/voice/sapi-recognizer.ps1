# sapi-recognizer.ps1
# Windows SAPI 5 语音识别子进程（日程侧边栏 语音输入）
#
# 协议：
#   stdin  收到 'start' 触发一次同步识别
#          收到 'exit'  关闭引擎并退出
#   stdout 每行输出一个 JSON：{"event":"ready|recognized|no_speech|error|fatal","text":...,"isFinal":bool,"confidence":num}
#
# 同步模式：识别期间不可中断，需等待超时或自然结束（5-8 秒）。
# 优点：无事件回调复杂性，输出顺序确定；缺点：无法提前 stop。
param([string]$Lang)
if ([string]::IsNullOrEmpty($Lang)) { $Lang = 'zh-CN' }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
function Send-Line {
  param([string]$Json)
  [Console]::Out.WriteLine($Json)
  [Console]::Out.Flush()
}

try {
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
    Send-Line ('{"event":"fatal","isFinal":true,"error":"No recognizer for ' + $Lang + ' (available: ' + $names + ')"}')
    return
  }
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($ri)
  $dictation = [System.Speech.Recognition.DictationGrammar]::new()
  $engine.LoadGrammar($dictation)
  [void]$engine.SetInputToDefaultAudioDevice()
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)
  $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(1)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(8)
  Send-Line '{"event":"ready"}'

  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq 'start') {
      try {
        $result = $engine.Recognize()
        if ($result -and $result.Text) {
          $text = $result.Text -replace '\\','\\' -replace '"','\"' -replace "`r"," " -replace "`n"," "
          $conf = [Math]::Round($result.Confidence, 3)
          Send-Line ('{"event":"recognized","text":"' + $text + '","isFinal":true,"confidence":' + $conf + '}')
        } else {
          Send-Line '{"event":"no_speech","isFinal":true,"error":"no_speech"}'
        }
      } catch {
        $msg = $_.Exception.Message -replace '\\','\\' -replace '"','\"' -replace "`r"," " -replace "`n"," "
        Send-Line ('{"event":"error","isFinal":true,"error":"' + $msg + '"}')
      }
    } elseif ($line -eq 'exit') {
      break
    }
  }
  $engine.Dispose()
} catch {
  $msg = $_.Exception.Message -replace '\\','\\' -replace '"','\"' -replace "`r"," " -replace "`n"," "
  Send-Line ('{"event":"fatal","isFinal":true,"error":"' + $msg + '"}')
}
