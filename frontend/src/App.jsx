import React, { useState, useEffect, useCallback } from 'react';
import TopBar from './components/TopBar.jsx';
import EditorPane from './components/EditorPane.jsx';
import CanvasPane from './components/CanvasPane.jsx';
import RightPanel from './components/RightPanel.jsx';
import ControlsBar from './components/ControlsBar.jsx';

const RIGHT_PANEL_KEY = 'stepwise.rightPanelOpen';
const EDITOR_OPEN_KEY = 'stepwise.editorOpen';
const LAYOUT_KEY = 'stepwise.layoutMode'; // '' | 'viz' | 'editor'

function loadBool(key, fallback = true) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v !== '0';
  } catch {
    return fallback;
  }
}

function loadLayout() {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'viz' || v === 'editor' ? v : null;
  } catch {
    return null;
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
  const [layoutMode, setLayoutMode] = useState(loadLayout); // null | 'viz' | 'editor'

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

  const setLayout = useCallback(
    (next) => {
      setLayoutMode(next);
      persist(LAYOUT_KEY, next || '');
      if (next) enterBrowserFullscreen();
      else exitBrowserFullscreen();
    },
    [enterBrowserFullscreen, exitBrowserFullscreen]
  );

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

  const toggleVizFocus = useCallback(() => {
    setLayout(layoutMode === 'viz' ? null : 'viz');
  }, [layoutMode, setLayout]);

  const toggleEditorFocus = useCallback(() => {
    setLayout(layoutMode === 'editor' ? null : 'editor');
  }, [layoutMode, setLayout]);

  // Leaving browser fullscreen exits layout focus
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement && layoutMode) {
        setLayoutMode(null);
        persist(LAYOUT_KEY, '');
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [layoutMode]);

  // F11 = viz fullscreen, E = editor fullscreen, Esc = exit
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inEditor = e.target.closest('.monaco-editor');
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape' && layoutMode) {
        e.preventDefault();
        setLayout(null);
        return;
      }
      if (e.key === 'F11') {
        e.preventDefault();
        toggleVizFocus();
        return;
      }
      if (inEditor) return;
      if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleEditorFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layoutMode, setLayout, toggleVizFocus, toggleEditorFocus]);

  const vizFocus = layoutMode === 'viz';
  const editorFocus = layoutMode === 'editor';
  const showEditor = editorFocus || (!vizFocus && editorOpen);
  const showEditorRail = !editorFocus && !vizFocus && !editorOpen;
  const showCanvas = vizFocus || !editorFocus;
  const showRight = !editorFocus;

  const mainClass = [
    'app-main',
    !editorOpen && !vizFocus && !editorFocus ? 'editor-collapsed' : '',
    !rightOpen && showRight ? 'right-collapsed' : '',
    vizFocus ? 'focus-viz' : '',
    editorFocus ? 'focus-editor' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`app ${layoutMode ? `focus-${layoutMode}` : ''}`}>
      <TopBar
        layoutMode={layoutMode}
        onToggleVizFocus={toggleVizFocus}
        onToggleEditorFocus={toggleEditorFocus}
      />
      <div className={mainClass}>
        {showEditor && (
          <EditorPane
            focusMode={editorFocus}
            onToggleFocus={toggleEditorFocus}
            onCollapse={editorFocus ? undefined : toggleEditorOpen}
          />
        )}
        {showEditorRail && (
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
        {showCanvas && (
          <CanvasPane focusMode={vizFocus} onToggleFocus={toggleVizFocus} />
        )}
        {showRight && <RightPanel open={rightOpen} onToggle={toggleRight} />}
      </div>
      <ControlsBar />
    </div>
  );
}
