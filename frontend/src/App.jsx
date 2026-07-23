import React, { useState } from 'react';
import TopBar from './components/TopBar.jsx';
import EditorPane from './components/EditorPane.jsx';
import CanvasPane from './components/CanvasPane.jsx';
import RightPanel from './components/RightPanel.jsx';
import ControlsBar from './components/ControlsBar.jsx';

const RIGHT_PANEL_KEY = 'stepwise.rightPanelOpen';

function loadRightOpen() {
  try {
    const v = localStorage.getItem(RIGHT_PANEL_KEY);
    if (v === null) return true;
    return v !== '0';
  } catch {
    return true;
  }
}

export default function App() {
  const [rightOpen, setRightOpen] = useState(loadRightOpen);

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

  return (
    <div className="app">
      <TopBar />
      <div className={`app-main ${rightOpen ? '' : 'right-collapsed'}`}>
        <EditorPane />
        <CanvasPane />
        <RightPanel open={rightOpen} onToggle={toggleRight} />
      </div>
      <ControlsBar />
    </div>
  );
}
