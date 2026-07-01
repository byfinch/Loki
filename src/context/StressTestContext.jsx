/**
 * StressTestContext.jsx
 * 
 * Loki Panel state yonetimi.
 */

import React, { useReducer, createContext, useContext } from 'react';

const initialState = {
  status: 'idle', // idle, running, stopped
  attackId: null,
  logs: [],
  verificationData: {},
  user: null,
  plan: null,
  methods: [],
  liveAttacks: [],
  isAuthenticated: false,
  activeTab: 'attack', // attack, tools, loops
  activeLoops: {}, // { [loopId]: { running, params, startedAt, lastRoundAt, roundCount, errors } }
  toasts: [] // [{ id, message, type, duration }]
};

function stressTestReducer(state, action) {
  switch (action.type) {
    case 'START_TEST':
      return {
        ...state,
        status: 'running',
        attackId: action.payload.attackId,
        logs: [...state.logs, { message: 'Test başlatılıyor...', time: new Date().toISOString() }]
      };
    case 'STOP_TEST':
      return {
        ...state,
        status: 'stopped',
        attackId: null,
        logs: [...state.logs, { message: 'Test durduruldu.', time: new Date().toISOString() }]
      };
    case 'ADD_LOG':
      return {
        ...state,
        logs: [...state.logs, { message: action.payload.message, time: new Date().toISOString() }]
      };
    case 'UPDATE_VERIFICATION':
      return {
        ...state,
        verificationData: { ...state.verificationData, ...action.payload }
      };
    case 'SET_USER':
      return { ...state, user: action.payload, isAuthenticated: !!action.payload };
    case 'SET_PLAN':
      return { ...state, plan: action.payload };
    case 'SET_METHODS':
      return { ...state, methods: action.payload };
    case 'SET_LIVE_ATTACKS':
      return { ...state, liveAttacks: action.payload };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.payload };
    case 'ADD_LOOP':
      return {
        ...state,
        activeLoops: {
          ...state.activeLoops,
          [action.payload.loopId]: {
            ...action.payload.loop,
            running: true
          }
        }
      };
    case 'UPDATE_LOOP':
      return {
        ...state,
        activeLoops: {
          ...state.activeLoops,
          [action.payload.loopId]: {
            ...(state.activeLoops[action.payload.loopId] || {}),
            ...action.payload.updates
          }
        }
      };
    case 'REMOVE_LOOP':
      const nextLoops = { ...state.activeLoops };
      delete nextLoops[action.payload.loopId];
      return { ...state, activeLoops: nextLoops };
    case 'SET_LOOPS':
      return { ...state, activeLoops: action.payload };
    case 'ADD_TOAST':
      return { ...state, toasts: [...state.toasts, action.payload] };
    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.payload.id) };
    case 'LOGOUT':
      return { ...initialState };
    default:
      return state;
  }
}

export const StressTestContext = createContext();

export const StressTestProvider = ({ children }) => {
  const [state, dispatch] = useReducer(stressTestReducer, initialState);

  const startTest = (attackId) => dispatch({ type: 'START_TEST', payload: { attackId } });
  const stopTest = () => dispatch({ type: 'STOP_TEST' });
  const addLog = (message) => dispatch({ type: 'ADD_LOG', payload: { message } });
  const updateVerification = (data) => dispatch({ type: 'UPDATE_VERIFICATION', payload: data });
  const setUser = (user) => dispatch({ type: 'SET_USER', payload: user });
  const setPlan = (plan) => dispatch({ type: 'SET_PLAN', payload: plan });
  const setMethods = (methods) => dispatch({ type: 'SET_METHODS', payload: methods });
  const setLiveAttacks = (attacks) => dispatch({ type: 'SET_LIVE_ATTACKS', payload: attacks });
  const setActiveTab = (tab) => dispatch({ type: 'SET_ACTIVE_TAB', payload: tab });
  const addLoop = (loopId, loop) => dispatch({ type: 'ADD_LOOP', payload: { loopId, loop } });
  const updateLoop = (loopId, updates) => dispatch({ type: 'UPDATE_LOOP', payload: { loopId, updates } });
  const removeLoop = (loopId) => dispatch({ type: 'REMOVE_LOOP', payload: { loopId } });
  const setLoops = (loops) => dispatch({ type: 'SET_LOOPS', payload: loops });

  const showToast = (message, type = 'info', duration = 3000) => {
    const id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    dispatch({ type: 'ADD_TOAST', payload: { id, message, type, duration } });
    setTimeout(() => {
      dispatch({ type: 'REMOVE_TOAST', payload: { id } });
    }, duration);
  };

  const removeToast = (id) => dispatch({ type: 'REMOVE_TOAST', payload: { id } });

  const logout = () => dispatch({ type: 'LOGOUT' });

  return (
    <StressTestContext.Provider
      value={{
        state,
        startTest,
        stopTest,
        addLog,
        updateVerification,
        setUser,
        setPlan,
        setMethods,
        setLiveAttacks,
        setActiveTab,
        addLoop,
        updateLoop,
        removeLoop,
        setLoops,
        showToast,
        removeToast,
        logout
      }}
    >
      {children}
    </StressTestContext.Provider>
  );
};

export const useStressTest = () => {
  const context = useContext(StressTestContext);
  if (!context) {
    throw new Error('useStressTest must be used within a StressTestProvider');
  }
  return context;
};
