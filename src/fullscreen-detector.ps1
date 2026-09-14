# 全屏窗口检测器
# 通过 Win32 API 轮询前台窗口，判断是否覆盖整个屏幕
# 输出 "FULLSCREEN" 或 "NORMAL" 到 stdout（每行 flush 一次）

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WinCheck {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [StructLayout(Layout.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    // 获取前台窗口所属进程的可执行文件名（用于排除本应用）
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

# 当前 PowerShell 进程 ID，用于排除自身
$myPid = $PID

# SM_CXSCREEN = 0, SM_CYSCREEN = 1, SM_REMOTESESSION 不需要
$sw = [WinCheck]::GetSystemMetrics(0)
$sh = [WinCheck]::GetSystemMetrics(1)

# 容差：窗口矩形允许少许溢出（部分全屏游戏会略大于屏幕）
$tol = 2

while ($true) {
    Start-Sleep -Milliseconds 400
    try {
        $hwnd = [WinCheck]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) {
            [Console]::Out.WriteLine("NORMAL")
            [Console]::Out.Flush()
            continue
        }

        # 排除自身进程
        $procId = 0
        [void][WinCheck]::GetWindowThreadProcessId($hwnd, [ref]$procId)
        if ($procId -eq $myPid -or $procId -eq 0) {
            [Console]::Out.WriteLine("NORMAL")
            [Console]::Out.Flush()
            continue
        }

        $rect = New-Object WinCheck+RECT
        $ok = [WinCheck]::GetWindowRect($hwnd, [ref]$rect)
        if (-not $ok) {
            [Console]::Out.WriteLine("NORMAL")
            [Console]::Out.Flush()
            continue
        }

        # 判断是否覆盖整个屏幕（含容差）
        $isFull = ($rect.Left -le $tol) -and ($rect.Top -le $tol) -and `
                  ($rect.Right -ge ($sw - $tol)) -and ($rect.Bottom -ge ($sh - $tol))

        if ($isFull) {
            [Console]::Out.WriteLine("FULLSCREEN")
        } else {
            [Console]::Out.WriteLine("NORMAL")
        }
        [Console]::Out.Flush()
    } catch {
        [Console]::Out.WriteLine("NORMAL")
        [Console]::Out.Flush()
    }
}
