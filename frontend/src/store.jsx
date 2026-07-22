import React, { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import { requestTrace } from './api.js';
import { getExample, DEFAULT_EXAMPLE } from './examples.js';

const STORAGE_KEY = 'stepwise.session';
const LANGS = new Set(['python', 'c', 'cpp', 'java']);

const defaultExample = getExample(DEFAULT_EXAMPLE.language, DEFAULT_EXAMPLE.id);

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return null;
    return saved;
  } catch {
    return null;
  }
}

function buildInitialState() {
  const saved = loadPersisted();
  const language = LANGS.has(saved?.language) ? saved.language : DEFAULT_EXAMPLE.language;
  const fallback = getExample(language, saved?.exampleId) ?? getExample(language, null) ?? defaultExample;
  const theme = saved?.theme === 'light' || saved?.theme === 'dark' ? saved.theme : 'dark';
  const speed = typeof saved?.speed === 'number' && saved.speed > 0 ? saved.speed : 1;
  const hasCode = typeof saved?.code === 'string' && saved.code.length > 0;

  return {
    theme,
    language,
    exampleId: hasCode ? (saved?.exampleId ?? fallback.id) : fallback.id,
    code: hasCode ? saved.code : fallback.code,
    stdin: typeof saved?.stdin === 'string' ? saved.stdin : (fallback.stdin ?? ''),
    trace: null,
    stepIndex: 0,
    playing: false,
    speed,
    loading: false,
    loadError: null,
    breakpoints: Array.isArray(saved?.breakpoints)
      ? saved.breakpoints.filter((n) => Number.isInteger(n) && n > 0)
      : [],
    dirty: true,
  };
}

const initialState = buildInitialState();
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = initialState.theme;
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_THEME':
      return { ...state, theme: action.theme };
    case 'SET_LANGUAGE': {
      const ex = getExample(action.language, null);
      return {
        ...state,
        language: action.language,
        exampleId: ex?.id ?? null,
        code: ex?.code ?? '',
        stdin: ex?.stdin ?? '',
        trace: null,
        stepIndex: 0,
        playing: false,
        dirty: true,
        loadError: null,
        breakpoints: [],
      };
    }
    case 'LOAD_EXAMPLE': {
      const ex = getExample(state.language, action.id);
      if (!ex) return state;
      return {
        ...state,
        exampleId: ex.id,
        code: ex.code,
        stdin: ex.stdin ?? '',
        trace: null,
        stepIndex: 0,
        playing: false,
        dirty: true,
        loadError: null,
        breakpoints: [],
      };
    }
    case 'SET_CODE':
      return { ...state, code: action.code, dirty: true };
    case 'SET_STDIN':
      return { ...state, stdin: action.stdin, dirty: true };
    case 'RUN_START':
      return { ...state, loading: true, loadError: null, playing: false };
    case 'RUN_OK':
      return {
        ...state,
        loading: false,
        trace: action.trace,
        stepIndex: 0,
        dirty: false,
        playing: false,
      };
    case 'RUN_FAIL':
      return { ...state, loading: false, loadError: action.message, trace: null };
    case 'SET_STEP': {
      const max = (state.trace?.steps.length ?? 1) - 1;
      const idx = Math.max(0, Math.min(max, action.index));
      return { ...state, stepIndex: idx, playing: action.keepPlaying ? state.playing : false };
    }
    case 'STEP_FWD': {
      const max = (state.trace?.steps.length ?? 1) - 1;
      if (state.stepIndex >= max) return { ...state, playing: false };
      return { ...state, stepIndex: state.stepIndex + 1 };
    }
    case 'STEP_BACK':
      return { ...state, stepIndex: Math.max(0, state.stepIndex - 1), playing: false };
    case 'PLAY':
      if (!state.trace) return state;
      if (state.stepIndex >= state.trace.steps.length - 1) {
        return { ...state, stepIndex: 0, playing: true };
      }
      return { ...state, playing: true };
    case 'PAUSE':
      return { ...state, playing: false };
    case 'RESTART':
      return { ...state, stepIndex: 0, playing: false };
    case 'SET_SPEED':
      return { ...state, speed: action.speed };
    case 'TOGGLE_BREAKPOINT': {
      const has = state.breakpoints.includes(action.line);
      return {
        ...state,
        breakpoints: has ? state.breakpoints.filter((l) => l !== action.line) : [...state.breakpoints, action.line],
      };
    }
    default:
      return state;
  }
}

const StoreCtx = createContext(null);

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // theme attribute on <html>
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  // persist editor session across refresh
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          theme: state.theme,
          language: state.language,
          exampleId: state.exampleId,
          code: state.code,
          stdin: state.stdin,
          speed: state.speed,
          breakpoints: state.breakpoints,
        })
      );
    } catch {
      // quota / private mode — ignore
    }
  }, [state.theme, state.language, state.exampleId, state.code, state.stdin, state.speed, state.breakpoints]);

  // autoplay timer
  useEffect(() => {
    if (!state.playing || !state.trace) return undefined;
    const interval = Math.max(80, 750 / state.speed);
    const t = setInterval(() => {
      const s = stateRef.current;
      const next = s.stepIndex + 1;
      if (!s.trace || next > s.trace.steps.length - 1) {
        dispatch({ type: 'PAUSE' });
        return;
      }
      // stop at breakpoints
      const step = s.trace.steps[next];
      if (s.breakpoints.includes(step.line) && step.event === 'line') {
        dispatch({ type: 'SET_STEP', index: next });
        dispatch({ type: 'PAUSE' });
        return;
      }
      dispatch({ type: 'STEP_FWD' });
    }, interval);
    return () => clearInterval(t);
  }, [state.playing, state.speed, state.trace]);

  const run = async () => {
    const s = stateRef.current;
    dispatch({ type: 'RUN_START' });
    try {
      const trace = await requestTrace(s.language, s.code, s.stdin);
      dispatch({ type: 'RUN_OK', trace });
    } catch (e) {
      dispatch({ type: 'RUN_FAIL', message: e.message || 'Failed to reach the StepWise engine' });
    }
  };

  return <StoreCtx.Provider value={{ state, dispatch, run }}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  return useContext(StoreCtx);
}

/** Current step object (or null). */
export function useCurrentStep() {
  const { state } = useStore();
  return state.trace?.steps[state.stepIndex] ?? null;
}

/** Previous step object (for diffing). */
export function usePrevStep() {
  const { state } = useStore();
  if (!state.trace || state.stepIndex === 0) return null;
  return state.trace.steps[state.stepIndex - 1];
}
