/**
 * CommandParser — 自然语言意图解析抽象（Shared Core）
 *
 * 接收语音识别产出的 Text，解析为结构化 Intent，供现有业务 Service 消费。
 * 业务核心（addEvent / updateProject 等）只接收 Intent，不接触语音/音频 API。
 *
 * 数据流：
 *   VoiceService → Text → CommandParser → Intent → 现有 Task/Project/Note Service
 *
 * 示例：
 *   输入: "明天下午三点提醒我给客户发方案，高优先级"
 *   输出: { type: "create_task", title: "给客户发方案", date: "2026-09-16", time: "15:00", priority: "high" }
 *
 * 本阶段只定义意图枚举和接口预留，不实现 NLP/AI 解析。
 */

// 意图类型枚举
const IntentType = Object.freeze({
  CREATE_TASK: 'create_task',       // 创建事项
  CREATE_NOTE: 'create_note',       // 创建便签
  EDIT_TASK: 'edit_task',           // 修改事项
  SET_PRIORITY: 'set_priority',     // 设置优先级
  SET_DATE: 'set_date',             // 设置日期/时间
  DELETE_TASK: 'delete_task',       // 删除事项
  UNKNOWN: 'unknown'                 // 未识别
});

// 优先级枚举（与现有项目优先级定义对齐）
const PriorityLevel = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
});

/**
 * Intent 结构（CommandParser 的输出）
 *
 * type: IntentType
 * title: string          事项/便签标题
 * date: string | null    ISO 日期（如 "2026-09-16"），null 表示未指定
 * time: string | null    时间（如 "15:00"），null 表示未指定
 * priority: PriorityLevel | null  优先级，null 表示未指定
 * noteContent: string | null  便签内容（仅 create_note）
 * taskId: string | null  目标事项 ID（仅 edit_task / set_priority / set_date / delete_task）
 * raw: string            原始文本（调试用）
 */
const Intent = Object.freeze({
  type: IntentType.UNKNOWN,
  title: '',
  date: null,
  time: null,
  priority: null,
  noteContent: null,
  taskId: null,
  raw: ''
});

/**
 * CommandParser 抽象接口
 * 未来实现需提供：
 *
 *   parse(text, context?) → Promise<Intent>   将文本解析为意图
 *   parseSync(text, context?) → Intent        同步解析（简单规则引擎可用）
 *
 * context 可选字段：
 *   currentDate: Date    当前日期锚点（解析"明天"/"下周"用）
 *   existingTasks: Array  已有事项列表（解析"修改刚才那个事项"用）
 *
 * 未来实现路径：
 *   1. RuleBasedParser：正则/关键词匹配（简单场景，纯本地，零依赖）
 *   2. LLMParser：本地小模型或云端 LLM（复杂自然语言，可选）
 */
module.exports = { IntentType, PriorityLevel, Intent };
