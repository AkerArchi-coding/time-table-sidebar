/**
 * VoiceService — 语音输入抽象接口（Shared Core）
 *
 * 职责：麦克风权限、录音、开始/停止、语音转文字、状态管理、错误处理。
 * 不包含任何平台 API 调用——具体实现由 Platform Adapter（如 ElectronVoiceService）提供。
 *
 * 数据流：用户说话 → VoiceService → SpeechProvider → Text → CommandParser → Intent → 现有业务 Service
 *
 * 未来实现步骤：
 *   1. ElectronVoiceService：用 Chromium MediaRecorder + webkitSpeechRecognition 实现
 *   2. iOS/Android：各自平台工程中实现此接口
 *   3. 业务核心（Task/Project/Note CRUD）永远不直接依赖此接口，只接收 text/intent
 */

// 录音状态枚举
const VoiceState = Object.freeze({
  IDLE: 'idle',          // 空闲，未开始录音
  RECORDING: 'recording', // 正在录音
  PROCESSING: 'processing', // 正在识别（STT）
  ERROR: 'error'         // 出错
});

// 语音识别结果
// text: 识别出的文字
// isFinal: 是否为最终结果（false 表示中间临时结果）
// confidence: 置信度 0-1（可选）
const VoiceResult = Object.freeze({
  text: '',
  isFinal: false,
  confidence: 0
});

// 语音错误
// code: 'permission_denied' | 'no_speech' | 'network' | 'not_implemented' | 'unknown'
// message: 人类可读的错误描述
const VoiceError = Object.freeze({
  code: 'unknown',
  message: ''
});

/**
 * VoiceService 抽象接口
 * 平台 Adapter 需实现以下全部方法：
 *
 *   getStatus()           → VoiceState
 *   start(options?)       → Promise<void>      开始录音/识别
 *   stop()                → Promise<void>      停止录音/识别
 *   onResult(callback)   → () => void          订阅识别结果（返回取消函数）
 *   onError(callback)     → () => void          订阅错误（返回取消函数）
 *   onStateChange(callback) → () => void        订阅状态变化（返回取消函数）
 *
 * options 可选字段（未来扩展）：
 *   language: 'zh-CN' | 'en-US' | ...   识别语言
 *   provider: 'system' | 'local' | 'cloud'  识别引擎（见 SpeechProvider.js）
 *   continuous: boolean   是否持续识别
 *   interimResults: boolean  是否返回中间结果
 */
module.exports = { VoiceState, VoiceResult, VoiceError };
