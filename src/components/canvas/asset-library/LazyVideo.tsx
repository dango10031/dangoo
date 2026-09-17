import { useEffect, useRef, useState, type VideoHTMLAttributes } from 'react'
import { mediaSrc } from '@/lib/media'

/**
 * 进入滚动视口才挂载的 <video>: 素材库里有多少个视频素材, 旧实现就有多少个 video 元素与
 * metadata 请求常驻整个面板会话。这里与 LazyThumb 对称——不可见时不创建媒体元素,
 * 滚出视口/面板关闭卸载时浏览器释放解码与缓冲资源。
 */
export function LazyVideo(props: VideoHTMLAttributes<HTMLVideoElement> & { root?: HTMLElement | null }) {
  const { root, src, ...rest } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const forceVisible = typeof IntersectionObserver === 'undefined'

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ob = new IntersectionObserver(
      entries => {
        if (entries.some(en => en.isIntersecting)) setVisible(true)
      },
      { root: root ?? null, rootMargin: '200px', threshold: 0.01 },
    )
    ob.observe(el)
    return () => ob.disconnect()
  }, [root])

  return (
    <div ref={hostRef} className="h-full w-full">
      {(visible || forceVisible) && <video {...rest} src={mediaSrc(src as string)} />}
    </div>
  )
}
