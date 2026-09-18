import { describe, expect, it } from 'vitest'
import type { AiAppRunResponse } from '@/lib/aigc'
import {
  aiAppVideoUrl,
  motionVideoUrl,
  stripDeployedPrefix,
  ttsAudioUrl,
} from './canvasMediaUrl'

function resWith(outputs: Array<{ type?: string; url?: string }>, results: Array<{ type?: string; url?: string }> = []): AiAppRunResponse {
  return { outputs, results } as unknown as AiAppRunResponse
}

describe('ttsAudioUrl', () => {
  it('优先取 type=audio', () => {
    const res = resWith([
      { type: 'image', url: 'http://x/a.png' },
      { type: 'audio', url: 'http://x/v.mp3' },
    ])
    expect(ttsAudioUrl(res)).toBe('http://x/v.mp3')
  })

  it('无 type 标注时按音频扩展名兜底', () => {
    const res = resWith([{ url: 'http://x/clip.WAV?x=1' }])
    expect(ttsAudioUrl(res)).toBe('http://x/clip.WAV?x=1')
  })

  it('results 与 outputs 合并查找；都没有时返回空串', () => {
    expect(ttsAudioUrl(resWith([], [{ type: 'audio', url: 'http://x/r.m4a' }]))).toBe('http://x/r.m4a')
    expect(ttsAudioUrl(resWith([]))).toBe('')
  })
})

describe('motionVideoUrl', () => {
  it('优先视频类型，其次视频扩展名，最后任意 url', () => {
    expect(motionVideoUrl(resWith([{ type: 'video', url: 'http://x/a.mp4' }]))).toBe('http://x/a.mp4')
    expect(motionVideoUrl(resWith([{ url: 'http://x/b.mov' }]))).toBe('http://x/b.mov')
    expect(motionVideoUrl(resWith([{ url: 'http://x/c.bin' }]))).toBe('http://x/c.bin')
    expect(motionVideoUrl(resWith([]))).toBe('')
  })
})

describe('aiAppVideoUrl', () => {
  it('只认 type=video，否则退任意 url（不按扩展名猜）', () => {
    expect(aiAppVideoUrl(resWith([{ type: 'video', url: 'http://x/v' }]))).toBe('http://x/v')
    expect(aiAppVideoUrl(resWith([{ url: 'http://x/whatever' }]))).toBe('http://x/whatever')
  })
})

describe('stripDeployedPrefix', () => {
  const oldPrefix = '/app-preview/app-ca81449e917d4660aa213c5c13d47008/__pb'

  it('剥掉字符串里固化的部署前缀', () => {
    expect(stripDeployedPrefix(`${oldPrefix}/api/files/x/1/a.png`)).toBe('/api/files/x/1/a.png')
    expect(stripDeployedPrefix('/p/app-ca81449e917d4660aa213c5c13d47008/__pb/api/files/y/2/b.mp4')).toBe('/api/files/y/2/b.mp4')
  })

  it('不带前缀的字符串与 CDN 链接原样返回', () => {
    expect(stripDeployedPrefix('http://rh-images.xiaoyaoyou.com/abc/output/o.png')).toBe('http://rh-images.xiaoyaoyou.com/abc/output/o.png')
    expect(stripDeployedPrefix('/api/files/z/3/c.png')).toBe('/api/files/z/3/c.png')
  })

  it('递归处理数组与对象嵌套', () => {
    const doc = {
      name: '画布',
      cards: [
        { url: `${oldPrefix}/api/files/c/1/a.jpg`, keep: 1 },
        { nested: { deep: `${oldPrefix}/api/files/c/2/b.jpg` } },
      ],
      meta: { count: 2 },
    }
    const out = stripDeployedPrefix(doc) as {
      name: string
      cards: Array<{ url?: string; nested?: { deep: string } }>
      meta: { count: number }
    }
    expect(out.cards[0]?.url).toBe('/api/files/c/1/a.jpg')
    expect(out.cards[1]?.nested?.deep).toBe('/api/files/c/2/b.jpg')
    expect(out.name).toBe('画布')
    expect(out.meta.count).toBe(2)
  })

  it('原始入参不被修改（返回新对象）', () => {
    const doc = { url: `${oldPrefix}/api/files/c/1/a.jpg` }
    stripDeployedPrefix(doc)
    expect(doc.url).toBe(`${oldPrefix}/api/files/c/1/a.jpg`)
  })

  it('null / 数字 / 布尔原样返回', () => {
    expect(stripDeployedPrefix(null)).toBeNull()
    expect(stripDeployedPrefix(42)).toBe(42)
    expect(stripDeployedPrefix(true)).toBe(true)
  })
})
