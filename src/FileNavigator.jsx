import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Folder } from 'lucide-react';

function ancestors(path) {
  const parts = path.split('/').filter(Boolean);
  return ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)];
}

function resolvePath(value, current, home) {
  const input = value.trim();
  const expanded = input === '~' ? home || current || '/' : input.startsWith('~/') ? `${home || current || '/'}/${input.slice(2)}` : input;
  const combined = expanded.startsWith('/') ? expanded : `${current || '/'}/${expanded}`;
  const parts = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function FileNavigator({ hostLabel, path, home, disabled, loading, onNavigate }) {
  const [value, setValue] = useState(path);
  const [open, setOpen] = useState(false);
  const ref = useRef(null), input = useRef(null), trigger = useRef(null), menu = useRef(null);
  const id = useId();
  useEffect(() => { setValue(path); setOpen(false); }, [path]);
  useEffect(() => {
    const shortcut = event => {
      if (disabled || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'l') return;
      event.preventDefault(); setOpen(false); input.current?.focus(); input.current?.select();
    };
    document.addEventListener('keydown', shortcut, true);
    return () => document.removeEventListener('keydown', shortcut, true);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    const frame = requestAnimationFrame(() => menu.current?.querySelector('[role="menuitem"][aria-current]')?.focus());
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const choose = destination => { setOpen(false); setValue(destination); onNavigate(destination); input.current?.focus(); };
  const move = event => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.current.querySelectorAll('[role="menuitem"]')], index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : (index + 1) % items.length;
    items[next]?.focus();
  };
  return <form ref={ref} className="host-files-navigator" role="navigation" aria-label="현재 폴더" onSubmit={event => { event.preventDefault(); if (!disabled && value.trim()) { const destination = resolvePath(value, path, home); setOpen(false); setValue(destination); onNavigate(destination); } }}>
    <span className="host-files-navigator-host" title={hostLabel}>{hostLabel}</span>
    <input ref={input} className="host-files-navigator-input" aria-label="원격 폴더 경로" value={value} onChange={event => setValue(event.target.value)} disabled={disabled} aria-busy={loading} placeholder="폴더 경로" autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setValue(path); setOpen(false); input.current?.select(); }
    }}/>
    <button ref={trigger} type="button" className="host-files-navigator-toggle" aria-label="상위 경로 목록" title="상위 경로 목록" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled || !path} onClick={() => setOpen(previous => !previous)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><ChevronDown size={14} aria-hidden="true"/></button>
    {open && <div ref={menu} id={id} className="host-files-navigator-menu" role="menu" aria-label="상위 경로" onKeyDown={move}>{ancestors(path).map(destination => <button type="button" role="menuitem" tabIndex={-1} key={destination} aria-current={destination === path ? 'location' : undefined} onClick={() => choose(destination)}><Folder size={14} aria-hidden="true"/><span>{destination}</span>{destination === path && <Check size={14} aria-hidden="true"/>}</button>)}</div>}
  </form>;
}
