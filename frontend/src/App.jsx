import React, { useState, useEffect, useCallback } from 'react';
import TopBar from './components/TopBar.jsx';
import EditorPane from './components/EditorPane.jsx';
import CanvasPane from './components/CanvasPane.jsx';
import RightPanel from './components/RightPanel.jsx';
import ControlsBar from './components/ControlsBar.jsx';

const RIGHT_PANEL_KEY = 'stepwise.rightPanelOpen';
const EDITOR_OPEN_KEY = 'stepwise.editorOpen';

function loadBool(key, fallback = true) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v !== '0';
  } catch {
    return fallback;
  }
}

function persist(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [rightOpen, setRightOpen] = useState(() => loadBool(RIGHT_PANEL_KEY, true));
  const [editorOpen, setEditorOpen] = useState(() => loadBool(EDITOR_OPEN_KEY, true));
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    // Clear old layout-focus preference that hid panels
    try {
      localStorage.removeItem('stepwise.layoutMode');
      localStorage.removeItem('stepwise.focusMode');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // F11 → whole-page Fullscreen API (same layout, just fullscreen)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen]);

  const toggleRight = () => {
    setRightOpen((o) => {
      const next = !o;
      persist(RIGHT_PANEL_KEY, next ? '1' : '0');
      return next;
    });
  };

  const toggleEditorOpen = () => {
    setEditorOpen((o) => {
      const next = !o;
      persist(EDITOR_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  };

  const mainClass = [
    'app-main',
    !editorOpen ? 'editor-collapsed' : '',
    !rightOpen ? 'right-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`app ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <TopBar isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />
      <div className={mainClass}>
        {editorOpen ? (
          <EditorPane onCollapse={toggleEditorOpen} />
        ) : (
          <aside className="pane left-rail">
            <button
              type="button"
              className="left-rail-btn"
              onClick={toggleEditorOpen}
              title="Expand code editor"
              aria-label="Expand code editor"
            >
              <span className="left-rail-icon">›</span>
              <span className="left-rail-label">Code</span>
            </button>
          </aside>
        )}
        <CanvasPane isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />
        <RightPanel open={rightOpen} onToggle={toggleRight} />
      </div>
      <ControlsBar />
    </div>
  );
}
