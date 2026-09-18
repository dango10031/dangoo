// 画布价格 / 花费文案纯函数：只依赖本地用户价表（与后端扣费同源），不持有任何状态。
// 从 useCanvas 抽出，供底行价格、批量确认框、生成日志花费展示复用。
import {
  AI_APP_USER_PRICE,
  ALL_VIDEO_MODELS,
  aiAppSlugOf,
  channelFamilyOf,
  modelKindOf,
  resolveRunModel,
  userRunPrice,
  type PriceParams,
} from './canvasModels'

// 批量任务项：model 是渠道 slug，params 只需计价档位字段（完整节点参数是超集）。
type PriceJob = { model: string; count: number; params?: PriceParams; hasImg?: boolean }

/** 模型价格缓存 key：视频按分辨率/时长，图片按分辨率/质量/比例区分档位 */
export function priceKeyFor(model: string, params?: PriceParams): string {
  const kind = modelKindOf(model)
  if (kind === 't2v' || kind === 'i2v') {
    return `${model}|${params?.resolution ?? '1k'}|${params?.videoDuration ?? '5'}`
  }
  return `${model}|${params?.resolution ?? '1k'}|${params?.quality ?? 'medium'}|${params?.aspectRatio ?? '1:1'}`
}

/**
 * 底行/确认框价格文案: 统一显示「用户实付价」(与后端真实扣费逐分一致)。
 *  - AI 应用渠道(wan22 等): 站内固定单价 / 次;
 *  - 矩阵视频(Mini/2.0/全能/Grok/2.5): 每秒用户价 × 时长; 固定按次(H3): 一口价; 标「¥」;
 *  - 图片: 每张固定价 × 数量。
 */
export function priceTextForModel(model: string, count: number, params?: PriceParams, hasImg = false): string {
  const fam = channelFamilyOf(model)
  const isVideo = fam ? fam.media === 'video' : ALL_VIDEO_MODELS.includes(model)
  // 有无参考图决定真实提交 slug, 价格按真实 slug 取(文生/图生各档价)
  const runModel = resolveRunModel(model, hasImg)

  // AI 应用渠道: 站内钱包固定单价(提交冻结/失败退回)
  if (aiAppSlugOf(runModel)) {
    const ap = AI_APP_USER_PRICE[runModel]
    return typeof ap === 'number' ? `¥${(ap * (count > 0 ? count : 1)).toFixed(2)} / 次` : '按实际扣费'
  }

  if (isVideo) {
    const total = userRunPrice(runModel, count, params)
    if (total !== null) return `¥${total.toFixed(2)}`
    return '按实际扣费'
  }

  // 图片: GPT Image 2 官方走分档, 其余固定价; 统一由 userRunPrice 算
  const total = userRunPrice(runModel, count, params)
  if (total !== null) return count > 1 ? `¥${total.toFixed(2)} / ${count} 张` : `¥${total.toFixed(2)} / 张`
  return '按实际扣费'
}

/**
 * 标准模型任务完成后的「本次花费」文案: 优先用后端回传的站内真实扣费额(与预估价同源),
 * 老任务无该字段时回退上游 RH usage 成本价, 都没有则不展示(返回 undefined / 空串)。
 */
export function stdCostText(
  res: { chargeAmount?: number | null; usage?: { thirdPartyConsumeMoney?: string | null } | null } | undefined | null,
  empty = '',
): string {
  const ca = Number(res?.chargeAmount)
  if (ca > 0) return `¥${ca.toFixed(2)}`
  const tp = res?.usage?.thirdPartyConsumeMoney
  return tp ? `¥${tp}` : empty
}

/**
 * AI 应用专用节点(语音克隆/动作迁移/视频修复, 以及视频渠道 wan22 系列)的花费:
 * 站内固定单价是权威实付价, 直接按已知价显示; 未知档位(如修复两档)可传显式单价。
 */
export function aiAppCostText(price: number | undefined | null): string | undefined {
  return typeof price === 'number' && price > 0 ? `¥${price.toFixed(2)}` : undefined
}

/** 图片批量二次确认阈值(元): 框选批量运行时图片任务总额超过它才强制确认, 视频不计入 */
export const BATCH_IMAGE_CONFIRM_LIMIT = 8

/** 批量任务里图片部分的费用汇总(视频/AI 应用不计), 与真实扣费同源 */
export function summarizeImageJobs(
  jobs: PriceJob[],
): { imageTotal: number; imageCount: number; hasVideo: boolean } {
  let imageTotal = 0
  let imageCount = 0
  let hasVideo = false
  jobs.forEach(j => {
    const runModel = resolveRunModel(j.model, !!j.hasImg)
    const fam = channelFamilyOf(runModel)
    const isVideo = fam ? fam.media === 'video' : ALL_VIDEO_MODELS.includes(runModel)
    if (isVideo) {
      hasVideo = true
      return
    }
    const p = userRunPrice(runModel, j.count, j.params)
    if (typeof p === 'number') {
      imageTotal += p
      imageCount += j.count
    }
  })
  return { imageTotal: Math.round(imageTotal * 100) / 100, imageCount, hasVideo }
}

/** 批量运行底行费用提示：能算清全部单价时给总额，否则只给数量与「按实际扣费」 */
export function priceNoteForJobs(
  jobs: PriceJob[],
): string {
  let total = 0
  let sum = 0
  let exact = true
  jobs.forEach(j => {
    total += j.count
    // 计价用解析后的真实模型(家族 key 在有图时对应图生 slug)
    const runModel = resolveRunModel(j.model, !!j.hasImg)
    // AI 应用渠道按站内固定单价; 其余标准渠道统一走用户价表(图片按张 / 矩阵视频按秒 / H3 按次)
    const ai = aiAppSlugOf(runModel)
    const p = ai ? (AI_APP_USER_PRICE[runModel] ?? null) : userRunPrice(runModel, 1, j.params)
    if (typeof p === 'number' && p > 0) {
      sum += p * j.count
    } else {
      exact = false
    }
    j.model = runModel
  })
  const video = jobs.some(j => ALL_VIDEO_MODELS.includes(j.model) || channelFamilyOf(j.model)?.media === 'video')
  const unit = video ? '个' : '张'
  if (exact && sum > 0) return `共 ${total} ${unit} · ¥${sum.toFixed(2)}`
  return `共 ${total} ${unit} · 按实际扣费`
}
