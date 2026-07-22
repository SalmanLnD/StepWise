import React, { useState, useEffect } from 'react';
import { useStore } from '../store.jsx';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

export default function ControlsBar() {
  const { state, dispatch } = useStore();
  const total = state.trace?.steps.length ?? 0;
  const has = total > 0 && !state.dirty;
  const [jump, setJump] = useState('');

  useEffect(() => setJump(''), [state.trace]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.closest('.monaco-editor')) return;
      if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'STEP_OVER' });
      } else if (e.key === 'ArrowRight' && e.altKey) {
        e.preventDefault();
        dispatch({ type: 'STEP_OUT' });
      } else if (e.key === 'ArrowRight') dispatch({ type: 'STEP_FWD' });
      else if (e.key === 'ArrowLeft') dispatch({ type: 'STEP_BACK' });
      else if (e.key === ' ') {
        e.preventDefault();
        dispatch({ type: state.playing ? 'PAUSE' : 'PLAY' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.playing]);

  const speedIdx = SPEEDS.indexOf(state.speed);
  const markers = [];
  if (has) {
    state.trace.steps.forEach((s, i) => {
      if (s.event === 'call') markers.push({ i, cls: 'call' });
      else if (s.event === 'return') markers.push({ i, cls: 'ret' });
    });
  }

  const atEnd = !has || state.stepIndex >= total - 1;
  const curNote = has ? state.trace.steps[state.stepIndex].note : '';
  const pendingCall = typeof curNote === 'string' && curNote.startsWith('→');

  return (
    <footer className="controls">
      <div className="transport">
        <button className="t-btn" title="Restart (go to step 0)" disabled={!has} onClick={() => dispatch({ type: 'RESTART' })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
        </button>
        <button className="t-btn" title="Previous step (←)" disabled={!has || state.stepIndex === 0} onClick={() => dispatch({ type: 'STEP_BACK' })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2.5v12H6zM19 6v12l-9-6z" />
          </svg>
        </button>
        <button
          className="t-btn primary"
          title={state.playing ? 'Pause (space)' : 'Play (space)'}
          disabled={!has}
          onClick={() => dispatch({ type: state.playing ? 'PAUSE' : 'PLAY' })}
        >
          {state.playing ? (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
            </svg>
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button
          className={`t-btn ${pendingCall ? 'emphasis' : ''}`}
          title="Step into (→) — enter the next call"
          disabled={atEnd}
          onClick={() => dispatch({ type: 'STEP_FWD' })}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v12" />
            <path d="M8 12l4 4 4-4" />
            <path d="M5 20h14" />
          </svg>
        </button>
        <button
          className="t-btn"
          title="Step over (Shift+→) — run call without entering"
          disabled={atEnd}
          onClick={() => dispatch({ type: 'STEP_OVER' })}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 14v-2a4 4 0 0 1 4-4h7" />
            <path d="M12 5l4 3-4 3" />
            <path d="M5 20h14" />
          </svg>
        </button>
        <button
          className="t-btn"
          title="Step out (Alt+→) — finish current function"
          disabled={atEnd || (has && state.trace.steps[state.stepIndex].frames.length <= 1)}
          onClick={() => dispatch({ type: 'STEP_OUT' })}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20V8" />
            <path d="M8 12l4-4 4 4" />
            <path d="M5 4h14" />
          </svg>
        </button>
      </div>

      <div className="speed-box">
        <span>Speed</span>
        <input
          type="range"
          min={0}
          max={SPEEDS.length - 1}
          step={1}
          value={speedIdx === -1 ? 2 : speedIdx}
          onChange={(e) => dispatch({ type: 'SET_SPEED', speed: SPEEDS[+e.target.value] })}
        />
        <span className="speed-val">{state.speed}×</span>
      </div>

      <div className="timeline">
        <div className="timeline-track">
          <div className="timeline-rail">
            <div
              className="timeline-fill"
              style={{ width: has && total > 1 ? `${(state.stepIndex / (total - 1)) * 100}%` : '0%' }}
            />
          </div>
          {has &&
            total > 1 &&
            markers.map((m) => (
              <span
                key={m.i}
                className={`timeline-marker ${m.cls}`}
                style={{ left: `${(m.i / (total - 1)) * 100}%` }}
              />
            ))}
          <input
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={state.stepIndex}
            disabled={!has}
            onChange={(e) => dispatch({ type: 'SET_STEP', index: +e.target.value })}
          />
        </div>
        <div className="timeline-labels">
          <span>step {has ? state.stepIndex + 1 : 0} / {total}</span>
          <span>
            {pendingCall && '→ about to call'}
            {has && !pendingCall && state.trace.steps[state.stepIndex].event === 'call' && '↘ function call'}
            {has && !pendingCall && state.trace.steps[state.stepIndex].event === 'return' && '↖ return'}
          </span>
          <span>{has ? `line ${state.trace.steps[state.stepIndex].line}` : '—'}</span>
        </div>
      </div>

      <div className="step-jump">
        <span>Jump</span>
        <input
          type="text"
          placeholder="#"
          value={jump}
          disabled={!has}
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = parseInt(jump, 10);
              if (!Number.isNaN(n)) dispatch({ type: 'SET_STEP', index: n - 1 });
            }
          }}
        />
      </div>
    </footer>
  );
}
