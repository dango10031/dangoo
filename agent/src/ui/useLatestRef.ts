import { useEffect, useRef } from 'react'

/** Keep a callback/value readable in async handlers without adding it as a dependency. */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
