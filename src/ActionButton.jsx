import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RefreshCw } from 'lucide-react';

export function ActionButton({ label, tooltip = label, icon: Icon, busy = false, className = '', as: Element = 'button', onFocus, onBlur, onMouseEnter, onMouseLeave, ...props }) {
  const ref = useRef(null);
  const id = useId();
  const [position, setPosition] = useState(null);
  const hide = () => setPosition(null);
  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const above = window.innerHeight - rect.bottom < 48;
    const width = Math.min(240, String(tooltip).length * 12 + 20);
    setPosition({ width, left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)), ...(above ? { bottom: window.innerHeight - rect.top + 7 } : { top: rect.bottom + 7 }) });
  };
  useEffect(() => {
    if (!position) return;
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    window.addEventListener('resize', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('resize', hide); document.removeEventListener('scroll', hide, true); document.removeEventListener('keydown', escape, true); };
  }, [position]);
  const DisplayIcon = busy && Icon !== RefreshCw ? Loader2 : Icon;
  return <>
    <Element ref={ref} {...(Element === 'button' ? { type: 'button' } : {})} {...props} className={`button icon-button action-button ${className}`} aria-label={label} aria-busy={busy} aria-describedby={position ? id : undefined} title={tooltip}
      onFocus={event => { show(); onFocus?.(event); }} onBlur={event => { hide(); onBlur?.(event); }} onMouseEnter={event => { show(); onMouseEnter?.(event); }} onMouseLeave={event => { hide(); onMouseLeave?.(event); }}>
      <DisplayIcon size={16} strokeWidth={1.8} aria-hidden="true" className={busy ? 'spin' : undefined}/>
    </Element>
    {position && createPortal(<div id={id} role="tooltip" className="action-tooltip" style={position}>{tooltip}</div>, document.body)}
  </>;
}
