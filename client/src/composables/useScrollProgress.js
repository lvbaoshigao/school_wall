// Keep scroll sampling outside Vue's render cycle: only the navigation surface changes.
export function observeScrollProgress(element, target = window) {
  let frame = null
  let previous = -1

  function update() {
    frame = null
    const offset = Number.isFinite(target.scrollY) ? target.scrollY : 0
    const progress = Math.min(1, Math.max(0, offset / 160))
    if (progress === previous) return
    previous = progress
    element.style.setProperty('--nav-scroll-progress', String(progress))
  }

  function schedule() {
    if (frame === null) frame = target.requestAnimationFrame(update)
  }

  target.addEventListener('scroll', schedule, { passive: true })
  target.addEventListener('pageshow', schedule)
  // History restoration can mount the header on an already scrolled page.
  update()

  return () => {
    target.removeEventListener('scroll', schedule)
    target.removeEventListener('pageshow', schedule)
    if (frame !== null) target.cancelAnimationFrame(frame)
    frame = null
  }
}
