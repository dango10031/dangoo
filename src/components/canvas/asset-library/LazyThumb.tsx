import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import { mediaSrc } from '@/lib/media'

/**
 * 进入视口才加载图片: IntersectionObserver 挂载在面板滚动容器内,
 * 未进入可视区前只渲染占位块, 不发起图片请求。
 */
export function LazyThumb(props: ImgHTMLAttributes<HTMLImageElement> & { root?: HTMLElement | null }) {
  const { root, src, ...rest } = props
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const forceVisible = typeof IntersectionObserver === 'undefined'

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ob = new IntersectionObserver(
      entries => {
        if (entries.some(en => en.isIntersecting)) {
          setVisible(true)
          ob.disconnect()
        }
      },
      { root: root ?? null, rootMargin: '120px', threshold: 0.01 },
    )
    ob.observe(el)
    return () => ob.disconnect()
  }, [root])

  return (
    <div ref={ref} className="h-full w-full">
      {(visible || forceVisible) && (
        <img
          {...rest}
          src={mediaSrc(src as string)}
          onLoad={e => {
            setLoaded(true)
            rest.onLoad?.(e)
          }}
          className={`${rest.className ?? ''} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  )
}
