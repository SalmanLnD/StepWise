import React from 'react';
import { useStore } from '../store.jsx';
import { EXAMPLES } from '../examples.js';

const LANGS = [
  { id: 'python', label: 'Python' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'java', label: 'Java' },
];

export default function TopBar() {
  const { state, dispatch, run } = useStore();

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M4 17h5v-5h5V7h5"
              stroke="#fff"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        StepWise
        <span className="tagline">see the computer think</span>
      </div>

      <div className="lang-tabs">
        {LANGS.map((l) => (
          <button
            key={l.id}
            className={`lang-tab ${state.language === l.id ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_LANGUAGE', language: l.id })}
          >
            {l.label}
          </button>
        ))}
      </div>

      <select
        className="select"
        value={state.exampleId ?? ''}
        onChange={(e) => dispatch({ type: 'LOAD_EXAMPLE', id: e.target.value })}
        title="Load an example"
      >
        {(EXAMPLES[state.language] ?? []).map((ex) => (
          <option key={ex.id} value={ex.id}>
            {ex.topic} · {ex.title}
          </option>
        ))}
      </select>

      <div className="topbar-right">
        <button
          className="icon-btn"
          title={state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => dispatch({ type: 'SET_THEME', theme: state.theme === 'dark' ? 'light' : 'dark' })}
        >
          {state.theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
            </svg>
          )}
        </button>

        <button className="btn btn-run" onClick={run} disabled={state.loading}>
          {state.loading ? (
            <>
              <span className="spinner" /> Tracing…
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              Visualize
            </>
          )}
        </button>
      </div>
    </header>
  );
}
