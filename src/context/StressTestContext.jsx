/**
 * StressTestContext.jsx
 * 
 * Loki Panel state yonetimi.
 */

import React, { useReducer, createContext, useContext, useMemo, useCallback, useRef, useEffect } from 'react';

const MAX_LOGS = 200;

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
  attackHistory: [], // Saldiri gecmis kayitlari
  stopProgress: null, // { current, total, successCount, failCount, percentage, label }
  activeStopKey: null, // Hangi satir/tum saldirilar durduruluyor
  stopCancelled: false, // Durdurma iptal edildi mi
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
        logs: [...state.logs, { message: action.payload.message, time: new Date().toISOString() }].slice(-MAX_LOGS)
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
    case 'SET_ATTACK_HISTORY':
      return { ...state, attackHistory: action.payload };
    case 'SET_STOP_PROGRESS':
      return { ...state, stopProgress: action.payload };
    case 'SET_ACTIVE_STOP_KEY':
      return { ...state, activeStopKey: action.payload };
    case 'SET_STOP_CANCELLED':
      return { ...state, stopCancelled: action.payload };
    case 'RESET_STOP_PROGRESS':
      return { ...state, stopProgress: null, activeStopKey: null, stopCancelled: false };
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
  const toastTimeoutsRef = useRef(new Set());

  const clearToastTimeouts = useCallback(() => {
    toastTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
    toastTimeoutsRef.current.clear();
  }, []);

  // Unmount'ta bekleyen toast zamanlayicilarini temizle
  useEffect(() => clearToastTimeouts, [clearToastTimeouts]);

  const startTest = useCallback((attackId) => dispatch({ type: 'START_TEST', payload: { attackId } }), []);
  const stopTest = useCallback(() => dispatch({ type: 'STOP_TEST' }), []);
  const addLog = useCallback((message) => dispatch({ type: 'ADD_LOG', payload: { message } }), []);
  const updateVerification = useCallback((data) => dispatch({ type: 'UPDATE_VERIFICATION', payload: data }), []);
  const setUser = useCallback((user) => dispatch({ type: 'SET_USER', payload: user }), []);
  const setPlan = useCallback((plan) => dispatch({ type: 'SET_PLAN', payload: plan }), []);
  const setMethods = useCallback((methods) => dispatch({ type: 'SET_METHODS', payload: methods }), []);
  const setLiveAttacks = useCallback((attacks) => dispatch({ type: 'SET_LIVE_ATTACKS', payload: attacks }), []);
  const setActiveTab = useCallback((tab) => dispatch({ type: 'SET_ACTIVE_TAB', payload: tab }), []);
  const addLoop = useCallback((loopId, loop) => dispatch({ type: 'ADD_LOOP', payload: { loopId, loop } }), []);
  const updateLoop = useCallback((loopId, updates) => dispatch({ type: 'UPDATE_LOOP', payload: { loopId, updates } }), []);
  const removeLoop = useCallback((loopId) => dispatch({ type: 'REMOVE_LOOP', payload: { loopId } }), []);
  const setLoops = useCallback((loops) => dispatch({ type: 'SET_LOOPS', payload: loops }), []);
  const setAttackHistory = useCallback((history) => dispatch({ type: 'SET_ATTACK_HISTORY', payload: history }), []);
  const setStopProgress = useCallback((progress) => dispatch({ type: 'SET_STOP_PROGRESS', payload: progress }), []);
  const setActiveStopKey = useCallback((key) => dispatch({ type: 'SET_ACTIVE_STOP_KEY', payload: key }), []);
  const setStopCancelled = useCallback((cancelled) => dispatch({ type: 'SET_STOP_CANCELLED', payload: cancelled }), []);
  const resetStopProgress = useCallback(() => dispatch({ type: 'RESET_STOP_PROGRESS' }), []);

  const showToast = useCallback((message, type = 'info', duration = 3000) => {
    const id = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    dispatch({ type: 'ADD_TOAST', payload: { id, message, type, duration } });
    const timeoutId = setTimeout(() => {
      toastTimeoutsRef.current.delete(timeoutId);
      dispatch({ type: 'REMOVE_TOAST', payload: { id } });
    }, duration);
    toastTimeoutsRef.current.add(timeoutId);
  }, []);

  const removeToast = useCallback((id) => dispatch({ type: 'REMOVE_TOAST', payload: { id } }), []);

  const logout = useCallback(() => {
    clearToastTimeouts();
    dispatch({ type: 'LOGOUT' });
  }, [clearToastTimeouts]);

  const value = useMemo(
    () => ({
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
      setAttackHistory,
      setStopProgress,
      setActiveStopKey,
      setStopCancelled,
      resetStopProgress,
      showToast,
      removeToast,
      logout
    }),
    [
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
      setAttackHistory,
      setStopProgress,
      setActiveStopKey,
      setStopCancelled,
      resetStopProgress,
      showToast,
      removeToast,
      logout
    ]
  );

  return (
    <StressTestContext.Provider value={value}>
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
