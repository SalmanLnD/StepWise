import React, { useState, useEffect, useCallback } from 'react';
import TopBar from './components/TopBar.jsx';
import EditorPane from './components/EditorPane.jsx';
import CanvasPane from './components/CanvasPane.jsx';
import RightPanel from './components/RightPanel.jsx';
import ControlsBar from './components/ControlsBar.jsx';

const RIGHT_PANEL_KEY = 'stepwise.rightPanelOpen';
const FOCUS_KEY = 'stepwise.focusMode';

function loadRightOpen() {
  try {
    const v = localStorage.getItem(RIGHT_PANEL_KEY);
    if (v === null) return true;
    return v !== '0';
  } catch {
    return true;
  }
}

function loadFocus() {
  try {
    return localStorage.getItem(FOCUS_KEY) === '1';
  } catch {
    return false;
  }
}

export default function App() {
  const [rightOpen, setRightOpen] = useState(loadRightOpen);
  const [focusMode, setFocusMode] = useState(loadFocus);

  const persistFocus = (next) => {
    try {
      localStorage.setItem(FOCUS_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const toggleRight = () => {
    setRightOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(RIGHT_PANEL_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const enterBrowserFullscreen = useCallback(() => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  const exitBrowserFullscreen = useCallback(() => {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const setFocus = useCallback(
    (next) => {
      setFocusMode(next);
      persistFocus(next);
      if (next) enterBrowserFullscreen();
      else exitBrowserFullscreen();
    },
    [enterBrowserFullscreen, exitBrowserFullscreen]
  );

  const toggleFocus = useCallback(() => {
    setFocus(!focusMode);
  }, [focusMode, setFocus]);

  // Exit focus when user leaves browser fullscreen (Esc)
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement && focusMode) {
        setFocusMode(false);
        persistFocus(false);
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [focusMode]);

  // Keyboard: F toggles focus (when not typing); Esc exits focus
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.closest('.monaco-editor')) return;
      if (e.key === 'Escape' && focusMode) {
        e.preventDefault();
        setFocus(false);
      } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, setFocus, toggleFocus]);

  return (
    <div className={`app ${focusMode ? 'focus-mode' : ''}`}>
      <TopBar focusMode={focusMode} onToggleFocus={toggleFocus} />
      <div
        className={`app-main ${rightOpen ? '' : 'right-collapsed'} ${focusMode ? 'focus-mode' : ''}`}
      >
        {!focusMode && <EditorPane />}
        <CanvasPane focusMode={focusMode} onToggleFocus={toggleFocus} />
        <RightPanel open={rightOpen} onToggle={toggleRight} />
      </div>
      <ControlsBar />
    </div>
  );
}
