/**
 * SpeechProvider — 语音识别引擎抽象（Shared Core）
 *
 * VoiceService 通过 SpeechProvider 完成实际的语音转文字工作。
 * 不同 Provider 对接不同识别引擎，但都输出统一的 Text 字符串。
 *
 * 架构：
 *   VoiceService → SpeechProvider
 *                    ├── SystemSpeechProvider   （操作系统内置 STT，如 Windows SAPI / macOS SFSpeechRecognizer）
 *                    ├── LocalSpeechProvider     （本地模型，如 Vosk / Whisper.cpp，离线隐私优先）
 *                    └── CloudSpeechProvider     （云端服务，如 Azure / Google Cloud STT）
 *
 * 隐私设计：
 *   - LocalSpeechProvider 允许完全离线识别，音频不离开本机
 *   - CloudSpeechProvider 由设置面板显式选择，且业务核心不依赖云端
 *   - 默认 provider 应为 'system' 或 'local'，不默认上云
 *
 * 本阶段只定义枚举和接口预留，不实现任何 Provider。
 */

// Provider 类型枚举
const SpeechProviderType = Object.freeze({
  SYSTEM: 'system',   // 操作系统内置语音识别
  LOCAL: 'local',     // 本地模型（离线）
  CLOUD: 'cloud'      // 云端服务
});

/**
 * SpeechProvider 抽象接口
 * 各 Provider 实现需提供以下方法：
 *
 *   type                  → SpeechProviderType    引擎类型标识
 *   init(options)         → Promise<void>          初始化引擎
 *   isAvailable()         → Promise<boolean>       当前平台是否可用
 *   recognize(audioStream, options) → Promise<{ text, isFinal, confidence }>  核心识别方法
 *   dispose()             → Promise<void>          释放资源
 *
 * options 字段：
 *   language: 'zh-CN' | 'en-US' | ...
 *   sampleRate: number   音频采样率
 *   model: string        本地模型路径（仅 Local）
 *   apiKey: string       云端密钥（仅 Cloud，存本机不外传）
 */
module.exports = { SpeechProviderType };
