import React, { useRef, useEffect, useCallback, useState } from 'react';
import Editor from '@monaco-editor/react';
import { useStore, useCurrentStep } from '../store.jsx';

const MONACO_LANG = { python: 'python', c: 'c', cpp: 'cpp', java: 'java' };
const READS_INPUT = /\binput\s*\(|\bscanf\s*\(|\bcin\s*>>|\bgetline\s*\(|new\s+Scanner\b/;

function defineThemes(monaco) {
  monaco.editor.defineTheme('stepwise-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5b6378', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'a396ff' },
      { token: 'number', foreground: '7ee7fc' },
      { token: 'string', foreground: '9ce8b4' },
    ],
    colors: {
      'editor.background': '#0f1219',
      'editor.lineHighlightBackground': '#171b2666',
      'editorLineNumber.foreground': '#3d4356',
      'editorLineNumber.activeForeground': '#8b91a5',
      'editorGutter.background': '#0f1219',
      'editorIndentGuide.background1': '#1c2130',
      'scrollbarSlider.background': '#ffffff14',
    },
  });
  monaco.editor.defineTheme('stepwise-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '9aa1b5', fontStyle: 'italic' },
      { token: 'keyword', foreground: '6353f0' },
      { token: 'number', foreground: '0891b2' },
      { token: 'string', foreground: '059669' },
    ],
    colors: {
      'editor.background': '#f7f8fc',
      'editorLineNumber.foreground': '#c3c8d8',
      'editorGutter.background': '#f7f8fc',
    },
  });
}

export default function EditorPane({ onCollapse }) {
  const { state, dispatch } = useStore();
  const step = useCurrentStep();
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorRef = useRef([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const codeReadsInput = READS_INPUT.test(state.code);
  const [stdinOpen, setStdinOpen] = useState(codeReadsInput);
  const stdinAutoRef = useRef(codeReadsInput);
  // auto-open (never auto-close) when the code starts reading input
  useEffect(() => {
    if (codeReadsInput && !stdinAutoRef.current) setStdinOpen(true);
    stdinAutoRef.current = codeReadsInput;
  }, [codeReadsInput]);

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    defineThemes(monaco);
    monaco.editor.setTheme(stateRef.current.theme === 'dark' ? 'stepwise-dark' : 'stepwise-light');

    editor.onMouseDown((e) => {
      const t = e.target;
      if (
        t.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        t.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      ) {
        if (t.position) dispatch({ type: 'TOGGLE_BREAKPOINT', line: t.position.lineNumber });
      }
    });
  }, [dispatch]);

  // theme switching
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(state.theme === 'dark' ? 'stepwise-dark' : 'stepwise-light');
    }
  }, [state.theme]);

  // decorations: current line glow, executed dim, breakpoints, error line
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const decos = [];
    const err = state.trace?.error;

    if (step && !state.dirty) {
      // executed lines so far (dimmed), excluding the current one
      const executed = new Set();
      for (let i = 0; i < state.stepIndex; i++) {
        executed.add(state.trace.steps[i].line);
      }
      executed.delete(step.line);
      for (const lnum of executed) {
        decos.push({
          range: new monaco.Range(lnum, 1, lnum, 1),
          options: { isWholeLine: true, inlineClassName: 'sw-line-dim' },
        });
      }
      const isErr = step.event === 'exception';
      decos.push({
        range: new monaco.Range(step.line, 1, step.line, 1),
        options: {
          isWholeLine: true,
          className: isErr ? 'sw-line-error' : 'sw-line-current',
          glyphMarginClassName: isErr ? undefined : 'sw-line-current-glyph',
        },
      });
      if (!state.playing) {
        editor.revealLineInCenterIfOutsideViewport(step.line);
      } else {
        editor.revealLine(step.line);
      }
    } else if (err?.line) {
      decos.push({
        range: new monaco.Range(err.line, 1, err.line, 1),
        options: { isWholeLine: true, className: 'sw-line-error' },
      });
    }

    for (const bp of state.breakpoints) {
      decos.push({
        range: new monaco.Range(bp, 1, bp, 1),
        options: { glyphMarginClassName: 'sw-breakpoint' },
      });
    }

    decorRef.current = editor.deltaDecorations(decorRef.current, decos);
  }, [step, state.stepIndex, state.trace, state.breakpoints, state.dirty, state.playing]);

  const statusDot = state.dirty ? 'dirty' : state.trace?.error ? 'err' : state.trace ? 'ok' : '';
  const statusText = state.dirty
    ? 'edited — press Visualize'
    : state.trace?.error
      ? `${state.trace.error.kind} on line ${state.trace.error.line ?? '?'}`
      : state.trace
        ? `${state.trace.stepCount} steps traced`
        : 'ready';

  return (
    <section className="pane editor-pane">
      <div className="pane-header">
        Code
        <span className="spacer" />
        {step && !state.dirty && <span style={{ textTransform: 'none', letterSpacing: 0 }}>line {step.line}</span>}
        {onCollapse && (
          <button
            type="button"
            className="pane-collapse-btn"
            title="Collapse editor"
            aria-label="Collapse editor"
            onClick={onCollapse}
          >
            ‹
          </button>
        )}
      </div>
      <div className="editor-wrap">
        <Editor
          language={MONACO_LANG[state.language]}
          value={state.code}
          onChange={(v) => dispatch({ type: 'SET_CODE', code: v ?? '' })}
          onMount={handleMount}
          theme={state.theme === 'dark' ? 'stepwise-dark' : 'stepwise-light'}
          options={{
            fontFamily: "'JetBrains Mono', Consolas, monospace",
            fontSize: 13,
            lineHeight: 21,
            minimap: { enabled: true, scale: 1, renderCharacters: false },
            glyphMargin: true,
            folding: true,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            renderLineHighlight: 'none',
            padding: { top: 12, bottom: 12 },
            scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
            automaticLayout: true,
          }}
        />
      </div>
      <div className={`stdin-panel ${stdinOpen ? 'open' : ''}`}>
        <button type="button" className="stdin-toggle" onClick={() => setStdinOpen((o) => !o)}>
          <span className={`chev ${stdinOpen ? 'down' : ''}`}>▸</span>
          Input (stdin)
          {!stdinOpen && state.stdin.trim() && <span className="stdin-badge">{state.stdin.trim().split(/\r?\n/).length} line(s)</span>}
          {!stdinOpen && codeReadsInput && !state.stdin.trim() && <span className="stdin-badge warn">program reads input</span>}
        </button>
        {stdinOpen && (
          <textarea
            className="stdin-textarea"
            value={state.stdin}
            onChange={(e) => dispatch({ type: 'SET_STDIN', stdin: e.target.value })}
            placeholder={
              state.language === 'python'
                ? 'One line per input() call, e.g.\n5\n3 1 4 1 5'
                : 'Values separated by spaces or newlines, e.g.\n5\n3 1 4 1 5'
            }
            spellCheck={false}
            rows={3}
          />
        )}
      </div>
      <div className="editor-status">
        <span className={`dot ${statusDot}`} />
        {statusText}
        <span style={{ marginLeft: 'auto' }}>
          {state.breakpoints.length > 0 && `${state.breakpoints.length} breakpoint${state.breakpoints.length > 1 ? 's' : ''}`}
        </span>
      </div>
    </section>
  );
}
