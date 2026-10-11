// ============ 开机自启路径解析（纯函数，可 require 单测） ============
// 常规安装版：process.execPath 即真实 exe，直接使用。
// electron-builder 便携版：运行时进程 exe 是临时解压目录里的副本，
// 直接写注册表会导致开机启动的是临时路径（且随版本目录变化失效），
// 需用便携版注入的 PORTABLE_EXECUTABLE_FILE 环境变量（用户实际双击的 exe）兜底。
'use strict';

function resolveLaunchExe(execPath, env) {
  const portable = env && env.PORTABLE_EXECUTABLE_FILE;
  if (typeof portable === 'string' && /\.exe$/i.test(portable.trim())) {
    return portable.trim();
  }
  return execPath;
}

module.exports = { resolveLaunchExe };
