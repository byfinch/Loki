/**
 * src/components/StressPanel.jsx
 * 
 * Tailwind CSS kullanılmış, temiz, çalışır bir React bileşeni.
 * checkServices ve StressTestContext ile entegre.
 */

import React, { useState, useEffect, useContext } from 'react';
import { useStressTest } from '../context/StressTestContext';
import { checkHost, checkPing } from '../services/checkServices';

const StressPanel = () => {
    const { state, startTest, stopTest, addLog } = useStressTest();

    // Form State'leri
    const [target, setTarget] = useState('8.8.8.8');
    const [port, setPort] = useState(53);
    const [duration, setDuration] = useState(60);
    const [method, setMethod] = useState('L4'); 

    // Doğrulama Döngüsü (Polling)
    useEffect(() => {
        if (state.status === 'running' && state.attackId) {
            const interval = setInterval(async () => {
                // Check-Host ile ping kontrolü
                try {
                    const checkResult = await checkHost(target);
                    addLog(`Check-Host: ${checkResult.status || 'Ping atıldı.'}`);
                } catch (error) {
                    addLog(`Doğrulama Hatası: ${error.message}`);
                }
                
                // Ping.pe kontrolü
                try {
                    const pingResult = await checkPing(target);
                    addLog(`Ping.pe: Rapor alınıyor...`);
                } catch (error) {
                    addLog(`Ping.pe Hatası: ${error.message}`);
                }
            }, 5000);

            return () => clearInterval(interval);
        }
    }, [state.status, state.attackId, target, addLog]);

    // Saldırı Başlatma
    const handleStart = () => {
        if (state.status === 'running') {
            addLog('Test zaten çalışıyor!');
            return;
        }

        addLog('Test başlatılıyor...');
        
        // API Çağrısı Simülasyonu (Gerçek API'e entegre et)
        // Burada stress.st API'sini çağırın
        startTest({ attackId: 'temp_' + Date.now() });
    };

    // Saldırı Durdurma
    const handleStop = () => {
        stopTest();
        addLog('Test durduruldu.');
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-6 font-sans">
            <div className="max-w-4xl mx-auto">
                <h1 className="text-3xl font-bold mb-8 text-center text-blue-400">Stress Test & Verification Panel</h1>

                <div className="bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-700">
                    <h2 className="text-xl font-semibold mb-4 text-gray-300">Hedef Ayarları</h2>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label className="block text-gray-400 mb-2">Hedef (IP veya URL)</label>
                            <input
                                type="text"
                                value={target}
                                onChange={(e) => setTarget(e.target.value)}
                                className="w-full p-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                            />
                        </div>

                        <div>
                            <label className="block text-gray-400 mb-2">Port (L4 için)</label>
                            <input
                                type="number"
                                value={port}
                                onChange={(e) => setPort(e.target.value)}
                                className="w-full p-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                        <div>
                            <label className="block text-gray-400 mb-2">Süre (Saniye)</label>
                            <input
                                type="number"
                                value={duration}
                                onChange={(e) => setDuration(e.target.value)}
                                className="w-full p-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                            />
                        </div>

                        <div>
                            <label className="block text-gray-400 mb-2">Metod</label>
                            <select
                                value={method}
                                onChange={(e) => setMethod(e.target.value)}
                                className="w-full p-2 bg-gray-700 text-white rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                            >
                                <option value="L4">L4 (IP/Port)</option>
                                <option value="L7">L7 (URL)</option>
                            </select>
                        </div>
                    </div>

                    <div className="flex gap-4 mb-6">
                        <button
                            onClick={handleStart}
                            disabled={state.status === 'running'}
                            className={`flex-1 py-3 px-4 rounded font-bold transition-colors duration-200 ${
                                state.status === 'running' 
                                    ? 'bg-gray-600 text-gray-300 cursor-not-allowed' 
                                    : 'bg-green-600 hover:bg-green-700 text-white'
                            }`}
                        >
                            {state.status === 'running' ? 'Çalışıyor...' : 'Saldırı Başlat'}
                        </button>

                        <button
                            onClick={handleStop}
                            disabled={state.status === 'idle'}
                            className={`flex-1 py-3 px-4 rounded font-bold transition-colors duration-200 ${
                                state.status === 'idle' 
                                    ? 'bg-gray-600 text-gray-300 cursor-not-allowed' 
                                    : 'bg-red-600 hover:bg-red-700 text-white'
                            }`}
                        >
                            Durdur
                        </button>
                    </div>
                </div>

                {/* Durum ve Loglar */}
                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-700">
                        <h3 className="text-lg font-semibold mb-4 text-gray-300">Durum</h3>
                        <div className="flex items-center gap-2">
                            <span className={`w-3 h-3 rounded-full ${state.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`}></span>
                            <span className="text-xl font-bold uppercase">{state.status}</span>
                        </div>
                        <p className="mt-2 text-gray-400">ID: {state.attackId || 'Bekleniyor...'}</p>
                    </div>

                    <div className="bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-700">
                        <h3 className="text-lg font-semibold mb-4 text-gray-300">Doğrulama Servisleri</h3>
                        <ul className="text-sm text-gray-400 space-y-1">
                            <li className="flex justify-between border-b border-gray-700 pb-1">
                                <span>Check-Host</span>
                                <span className="text-green-400">Aktif</span>
                            </li>
                            <li className="flex justify-between border-b border-gray-700 pb-1">
                                <span>Ping.pe</span>
                                <span className="text-green-400">Aktif</span>
                            </li>
                            <li className="flex justify-between">
                                <span>FOFA</span>
                                <span className="text-yellow-400">Hazır</span>
                            </li>
                        </ul>
                    </div>
                </div>

                <div className="bg-gray-800 p-6 rounded-lg shadow-lg border border-gray-700 mt-6">
                    <h3 className="text-lg font-semibold mb-4 text-gray-300">Loglar</h3>
                    <div className="bg-black p-4 rounded h-48 overflow-y-auto font-mono text-sm">
                        {state.logs.length === 0 ? (
                            <p className="text-gray-500">Loglar bekleniyor...</p>
                        ) : (
                            state.logs.map((log, index) => (
                                <div key={index} className="mb-1">
                                    <span className="text-gray-500">[{log.time.split('T')[1].split('.')[0]}]</span>{' '}
                                    <span className={log.message.includes('Hata') ? 'text-red-400' : 'text-blue-400'}>
                                        {log.message}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default StressPanel;