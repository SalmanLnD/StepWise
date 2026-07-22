import React from 'react';
import TopBar from './components/TopBar.jsx';
import EditorPane from './components/EditorPane.jsx';
import CanvasPane from './components/CanvasPane.jsx';
import RightPanel from './components/RightPanel.jsx';
import ControlsBar from './components/ControlsBar.jsx';

export default function App() {
  return (
    <div className="app">
      <TopBar />
      <div className="app-main">
        <EditorPane />
        <CanvasPane />
        <RightPanel />
      </div>
      <ControlsBar />
    </div>
  );
}
