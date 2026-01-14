import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, doc, setDoc, onSnapshot, updateDoc, 
  collection, addDoc, deleteDoc, arrayUnion, arrayRemove
} from 'firebase/firestore';
import { 
  getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken 
} from 'firebase/auth';
import { 
  Bell, Mic, Volume2, Users, Play, Monitor, 
  Plus, Edit2, X, Music, Calendar, StopCircle, UserPlus, Trash2, Save
} from 'lucide-react';

// --- Firebase Yapılandırması ---
let firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// 1. Ortam Kontrolü (Canvas/Vercel)
// window['...'] notasyonu ESLint 'no-undef' hatasını engeller.
if (typeof window !== 'undefined' && window['__firebase_config']) {
  try {
    firebaseConfig = JSON.parse(window['__firebase_config']);
  } catch (e) {
    console.error("Config parse error", e);
  }
} 
// 2. Yerel Geliştirme (Localhost)
else {
  firebaseConfig = {
    // Buradaki bilgileri kendi Firebase projenizden aldığınız bilgilerle değiştirebilirsiniz.
    // Şu anki değerler örnek bir proje içindir, kendi projenizi oluşturduğunuzda güncelleyin.
    apiKey: "AIzaSyArZNOf5DYQUX_mt_rhz2gXN8KN3jBP2cE",
    authDomain: "zilsesi-6f0fd.firebaseapp.com",
    projectId: "zilsesi-6f0fd",
    storageBucket: "zilsesi-6f0fd.firebasestorage.app",
    messagingSenderId: "7681525450",
    appId: "1:7681525450:web:0afe94b4ba0eccbe7c1633"
  };
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// App ID kontrolü (window üzerinden güvenli erişim)
const appId = (typeof window !== 'undefined' && window['__app_id']) ? window['__app_id'] : 'smart-bell-app-pro';

const DAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const DEFAULT_SOUNDS = [
  { id: 'classic', name: 'Klasik Zil', url: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3' },
  { id: 'school', name: 'Okul Zili', url: 'https://assets.mixkit.co/active_storage/sfx/950/950-preview.mp3' },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [profileName, setProfileName] = useState(localStorage.getItem('bell_profile_name') || '');
  const [isStation, setIsStation] = useState(localStorage.getItem('bell_is_station') === 'true');
  const [activeTab, setActiveTab] = useState('control'); 
  
  const [systemState, setSystemState] = useState({
    volume: 50,
    activeControllerId: null,
    activeControllerName: '',
    announcementUrl: null,
    lastTriggeredBell: null,
    stopSignal: 0
  });

  const [schedule, setSchedule] = useState([]);
  const [customSounds, setCustomSounds] = useState([]);
  const [allowedUsers, setAllowedUsers] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [loginError, setLoginError] = useState('');
  
  // --- Modals State ---
  const [scheduleModal, setScheduleModal] = useState({ open: false, mode: 'add', data: null, day: null });
  const [passwordModal, setPasswordModal] = useState(false);
  
  // --- Audio Logic ---
  const stationAudioRef = useRef(new Audio());
  const previewAudioRef = useRef(new Audio());
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  // 1. Auth Init
  useEffect(() => {
    const initAuth = async () => {
      try {
        // window['...'] notasyonu ile güvenli erişim
        if (typeof window !== 'undefined' && window['__initial_auth_token']) {
          await signInWithCustomToken(auth, window['__initial_auth_token']);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) { console.error("Auth error:", err); }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    
    return () => {
        unsubscribe();
        if (previewAudioRef.current) previewAudioRef.current.pause();
        if (stationAudioRef.current) stationAudioRef.current.pause();
    };
  }, []);

  // 2. Data Sync
  useEffect(() => {
    if (!user) return;

    // System Settings
    const stateDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'system_meta', 'settings');
    const unsubState = onSnapshot(stateDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        
        if (isStation) {
            if (stationAudioRef.current) stationAudioRef.current.volume = (data.volume || 50) / 100;
            if (data.announcementUrl && data.announcementUrl !== systemState.announcementUrl) {
                stationAudioRef.current.src = data.announcementUrl;
                stationAudioRef.current.play().catch(e => console.error(e));
            }
            if (data.stopSignal && data.stopSignal !== systemState.stopSignal) {
                stationAudioRef.current.pause();
                stationAudioRef.current.currentTime = 0;
            }
        }
        setSystemState(prev => ({ ...prev, ...data }));
      } else {
        setDoc(stateDocRef, { volume: 50, activeControllerId: null, activeControllerName: '', announcementUrl: null, stopSignal: 0 });
      }
    });

    // Allowed Users Sync
    const usersDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'system_meta', 'users');
    const unsubUsers = onSnapshot(usersDocRef, (docSnap) => {
        if (docSnap.exists()) {
            setAllowedUsers(docSnap.data().list || []);
        } else {
            setDoc(usersDocRef, { list: [] });
        }
    });

    // Schedule & Sounds
    const unsubSchedule = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'schedule'), (snap) => {
      const items = [];
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      setSchedule(items);
    });

    const unsubSounds = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'sounds'), (snap) => {
      const items = [];
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      setCustomSounds(items);
    });

    return () => { unsubState(); unsubSchedule(); unsubSounds(); unsubUsers(); };
  }, [user, isStation, systemState.announcementUrl, systemState.stopSignal]);

  // 3. Station Loop
  useEffect(() => {
    if (!isStation || !user) return;
    const interval = setInterval(() => {
      const now = new Date();
      const currentDay = DAYS[now.getDay() === 0 ? 6 : now.getDay() - 1];
      const currentTime = now.toTimeString().slice(0, 5);
      
      schedule.forEach(item => {
        if (item.day === currentDay && item.time === currentTime) {
          const triggerKey = `${item.id}-${currentTime}`;
          if (systemState.lastTriggeredBell !== triggerKey) {
            stationAudioRef.current.src = item.soundUrl;
            stationAudioRef.current.volume = systemState.volume / 100;
            stationAudioRef.current.play().catch(e => console.error(e));
            updateSystemState({ lastTriggeredBell: triggerKey });
          }
        }
      });
    }, 5000); 
    return () => clearInterval(interval);
  }, [isStation, schedule, systemState.lastTriggeredBell, systemState.volume, user]);

  // --- Functions ---

  const updateSystemState = async (updates) => {
    if (!user) return;
    const stateRef = doc(db, 'artifacts', appId, 'public', 'data', 'system_meta', 'settings');
    await updateDoc(stateRef, updates);
  };

  const handleStopAll = async () => {
      await updateSystemState({ stopSignal: Date.now() });
      setStatusMsg("Sistem sesi durduruldu.");
      setTimeout(() => setStatusMsg(''), 2000);
  };

  const tryTakeControl = async () => {
    if (systemState.activeControllerId && systemState.activeControllerId !== user.uid) return false;
    await updateSystemState({ activeControllerId: user.uid, activeControllerName: profileName });
    return true;
  };

  const releaseControl = async () => {
    if (systemState.activeControllerId === user.uid) {
      await updateSystemState({ activeControllerId: null, activeControllerName: '' });
    }
  };

  const startRecording = async () => {
    if (!(await tryTakeControl())) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      chunksRef.current = [];
      mediaRecorderRef.current.ondataavailable = (e) => chunksRef.current.push(e.data);
      mediaRecorderRef.current.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/ogg; codecs=opus' });
        if (blob.size > 750 * 1024) { 
             setStatusMsg('Anons çok uzun!');
             setTimeout(() => setStatusMsg(''), 3000);
             releaseControl(); return;
        }
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          try { await updateSystemState({ announcementUrl: reader.result }); setStatusMsg('Anons gönderildi.'); } 
          catch (e) { setStatusMsg('Hata: Anons gönderilemedi.'); } 
          finally { releaseControl(); setTimeout(() => setStatusMsg(''), 3000); }
        };
      };
      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (err) { releaseControl(); }
  };

  // --- User Management Logic ---
  const handleLogin = (e) => {
      if (e.key === 'Enter') {
          const name = e.target.value.trim();
          if (!name) return;

          if (allowedUsers.includes(name)) {
              setProfileName(name);
              localStorage.setItem('bell_profile_name', name);
              setLoginError('');
          } else {
              setLoginError('Bu kullanıcı sistemde kayıtlı değil. Lütfen Terminalden ekleyin.');
          }
      }
  };

  const handleStationLogin = (e) => {
      e.preventDefault();
      const pwd = e.target.password.value;
      if (pwd === '1453') {
          setIsStation(true);
          setProfileName('Terminal');
          localStorage.setItem('bell_is_station', 'true');
          setPasswordModal(false);
      } else {
          alert("Hatalı şifre!");
      }
  };

  const addUser = async (e) => {
      e.preventDefault();
      const name = e.target.username.value.trim();
      if(name && !allowedUsers.includes(name)) {
          const usersRef = doc(db, 'artifacts', appId, 'public', 'data', 'system_meta', 'users');
          await updateDoc(usersRef, { list: arrayUnion(name) });
          e.target.reset();
      }
  };

  const removeUser = async (name) => {
      // window.confirm kullanımı ESLint hatasını çözer
      if(window.confirm(`${name} silinsin mi?`)) {
          const usersRef = doc(db, 'artifacts', appId, 'public', 'data', 'system_meta', 'users');
          await updateDoc(usersRef, { list: arrayRemove(name) });
      }
  };

  // --- Views ---

  const UsersView = () => (
      <div className="space-y-6 animate-in fade-in">
          <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2"><UserPlus size={20}/> Yeni Kullanıcı Ekle</h2>
              <form onSubmit={addUser} className="flex gap-2">
                  <input name="username" type="text" placeholder="Kullanıcı Adı (Örn: Ahmet Hoca)" className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 outline-none focus:border-blue-500" required />
                  <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white px-6 rounded-xl font-bold">Ekle</button>
              </form>
          </div>
          <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2"><Users size={20}/> Kayıtlı Kullanıcılar</h2>
              <div className="space-y-2">
                  {allowedUsers.length === 0 ? (
                      <div className="text-slate-500 text-sm">Henüz kayıtlı kullanıcı yok.</div>
                  ) : allowedUsers.map(u => (
                      <div key={u} className="flex justify-between items-center bg-slate-950 p-3 rounded-xl border border-slate-800">
                          <span className="font-bold">{u}</span>
                          <button onClick={() => removeUser(u)} className="p-2 text-red-500 hover:bg-red-500/10 rounded-lg"><Trash2 size={16}/></button>
                      </div>
                  ))}
              </div>
          </div>
      </div>
  );

  // --- Main Render ---

  if (!profileName && !isStation) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        {passwordModal && (
            <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
                <form onSubmit={handleStationLogin} className="bg-slate-900 p-8 rounded-3xl border border-slate-700 w-full max-w-sm text-center">
                    <h3 className="text-xl font-bold mb-4">Terminal Girişi</h3>
                    <input type="password" name="password" placeholder="Şifre" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 mb-4 text-center text-2xl tracking-widest outline-none focus:border-blue-500" autoFocus />
                    <div className="flex gap-2">
                        <button type="button" onClick={() => setPasswordModal(false)} className="flex-1 py-3 rounded-xl bg-slate-800 text-slate-400">İptal</button>
                        <button type="submit" className="flex-1 py-3 rounded-xl bg-blue-600 font-bold">Giriş</button>
                    </div>
                </form>
            </div>
        )}

        <div className="max-w-md w-full bg-slate-900 rounded-[2.5rem] p-10 shadow-2xl border border-slate-800 text-center relative overflow-hidden">
          <div className="bg-blue-600 w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-blue-900/50">
            <Bell size={40} />
          </div>
          <h1 className="text-3xl font-black mb-2 tracking-tight">Akıllı Zil Pro</h1>
          <p className="text-slate-400 mb-8 text-sm font-medium">Lütfen Terminal tarafından size verilen kullanıcı adını girin.</p>
          
          <div className="relative mb-4">
            <input 
                type="text" 
                placeholder="Kullanıcı Adı"
                className={`w-full bg-slate-950 border ${loginError ? 'border-red-500' : 'border-slate-800'} rounded-2xl px-6 py-4 focus:ring-2 focus:ring-blue-500 outline-none text-center font-bold transition-all`}
                onKeyDown={handleLogin}
            />
            {loginError && <div className="absolute top-full left-0 right-0 mt-2 text-red-500 text-xs font-bold bg-red-500/10 p-2 rounded-lg">{loginError}</div>}
          </div>

          <div className="mt-12 pt-6 border-t border-slate-800">
             <button onClick={() => setPasswordModal(true)} className="flex items-center justify-center gap-2 w-full text-xs font-black uppercase tracking-widest text-slate-600 hover:text-emerald-500 transition-colors">
                <Monitor size={14} /> Terminal Olarak Başlat
             </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <header className="bg-slate-900/50 backdrop-blur-xl border-b border-slate-800 p-4 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="bg-blue-600 p-2.5 rounded-xl shadow-lg shadow-blue-900/20"><Bell size={20} /></div>
            <div>
              <h1 className="font-black text-lg tracking-tight">ZİL SİSTEMİ PRO</h1>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isStation ? 'bg-emerald-500 animate-pulse' : 'bg-blue-500'}`}></div>
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-tighter">{isStation ? 'TERMİNAL AKTİF' : profileName}</span>
              </div>
            </div>
          </div>
          <div className="flex bg-slate-950 rounded-2xl p-1 border border-slate-800 hidden md:flex">
            <button onClick={() => setActiveTab('control')} className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'control' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>KONTROL</button>
            <button onClick={() => setActiveTab('planner')} className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'planner' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>PROGRAM</button>
            <button onClick={() => setActiveTab('sounds')} className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'sounds' ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>ZİL SESLERİ</button>
            {isStation && <button onClick={() => setActiveTab('users')} className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${activeTab === 'users' ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}>KULLANICILAR</button>}
          </div>
          
          <div className="flex items-center gap-2">
            {profileName && (
                <button onClick={() => { localStorage.removeItem('bell_profile_name'); localStorage.removeItem('bell_is_station'); window.location.reload(); }} className="p-2 bg-slate-800 rounded-full hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors" title="Çıkış Yap">
                    <X size={14} />
                </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8">
        {activeTab === 'control' && (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 shadow-xl flex flex-col justify-between">
                        <div>
                            <div className="flex items-center justify-between mb-8">
                                <h2 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><Volume2 size={16} /> Ses Seviyesi</h2>
                                <span className="text-3xl font-mono font-bold text-blue-500">{systemState.volume}%</span>
                            </div>
                            <input type="range" min="0" max="100" value={systemState.volume} onChange={(e) => { const val = e.target.value; setSystemState(s => ({...s, volume: val})); updateSystemState({ volume: parseInt(val) }); }} className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500 mb-6" />
                        </div>
                        <button onClick={handleStopAll} className="w-full bg-red-900/30 hover:bg-red-600 text-red-500 hover:text-white border border-red-900/50 p-4 rounded-xl flex items-center justify-center gap-3 transition-all active:scale-95 group"><StopCircle size={24} className="group-hover:animate-pulse" /><span className="font-bold">SESİ KES / DURDUR</span></button>
                    </div>
                    <div className="bg-slate-900 p-6 rounded-3xl border border-slate-800 flex flex-col items-center justify-center relative group min-h-[250px]">
                        <button onMouseDown={startRecording} onMouseUp={() => isRecording && mediaRecorderRef.current.stop()} onTouchStart={startRecording} onTouchEnd={() => isRecording && mediaRecorderRef.current.stop()} disabled={!!systemState.activeControllerId && systemState.activeControllerId !== user?.uid} className={`w-32 h-32 rounded-full flex items-center justify-center transition-all ${isRecording ? 'bg-red-600 animate-pulse shadow-2xl shadow-red-900/50 scale-110' : 'bg-slate-800 hover:bg-slate-700 shadow-xl'} disabled:opacity-20`}><Mic size={48} /></button>
                        <p className="mt-6 text-xs font-black uppercase tracking-widest text-slate-500 text-center">{isRecording ? 'CANLI YAYIN...' : 'ANONS İÇİN BASILI TUT'}</p>
                        {statusMsg && <div className="absolute top-4 bg-blue-500/20 text-blue-400 text-xs px-3 py-1 rounded-full">{statusMsg}</div>}
                    </div>
                </div>
            </div>
        )}
        {activeTab === 'planner' && (
            <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500 relative">
                 {scheduleModal.open && (
                    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
                        <div className="bg-slate-900 border border-slate-700 p-6 rounded-3xl w-full max-w-sm shadow-2xl">
                             <div className="flex justify-between items-center mb-6"><h3 className="font-bold text-lg text-white">Alarm Ekle/Düzenle</h3><button onClick={() => setScheduleModal({ open: false, mode: 'add', data: null, day: null })} className="p-2 bg-slate-800 rounded-full text-slate-400"><X size={20}/></button></div>
                             <form onSubmit={async (e) => { e.preventDefault(); const fd=new FormData(e.target); const newItem={time:fd.get('time'), label:fd.get('label'), soundUrl: (DEFAULT_SOUNDS.find(s=>s.id===fd.get('soundId')) || customSounds.find(s=>s.id===fd.get('soundId')) || DEFAULT_SOUNDS[0]).url}; try{ if(scheduleModal.mode==='edit'){ await updateDoc(doc(db,'artifacts',appId,'public','data','schedule',scheduleModal.data.id), newItem); }else{ await addDoc(collection(db,'artifacts',appId,'public','data','schedule'), {...newItem, day:scheduleModal.day}); } setScheduleModal({open:false, mode:'add', data:null, day:null}); }catch(err){console.error(err);} }} className="space-y-4">
                                <input name="time" type="time" required defaultValue={scheduleModal.data?.time||"08:00"} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 outline-none" />
                                <input name="label" placeholder="Etiket" defaultValue={scheduleModal.data?.label||""} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 outline-none" />
                                <select name="soundId" defaultValue={scheduleModal.data ? [...DEFAULT_SOUNDS, ...customSounds].find(s=>s.url===scheduleModal.data.soundUrl)?.id : 'classic'} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 outline-none">
                                    {[...DEFAULT_SOUNDS, ...customSounds].map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                                <button type="submit" className="w-full bg-blue-600 py-3 rounded-xl font-bold">Kaydet</button>
                             </form>
                        </div>
                    </div>
                )}
                <div className="flex flex-col md:flex-row gap-4 overflow-x-auto pb-4 custom-scrollbar min-h-[600px]">
                    {DAYS.map(day => (
                        <div key={day} className="min-w-[300px] bg-slate-900 rounded-3xl border border-slate-800 flex flex-col h-[600px] shadow-lg relative">
                             <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/95 sticky top-0 rounded-t-3xl z-10">
                                <h3 className="font-black text-xs uppercase text-blue-400">{day}</h3>
                                <button onClick={() => setScheduleModal({open:true, mode:'add', data:null, day})} className="p-2 bg-blue-600 rounded-lg"><Plus size={16}/></button>
                             </div>
                             <div className="p-2 overflow-y-auto flex-1 space-y-2">
                                {schedule.filter(s=>s.day===day).sort((a,b)=>a.time.localeCompare(b.time)).map(item=>(
                                    <div key={item.id} className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex justify-between items-center group">
                                        <div><div className="font-mono font-bold text-lg">{item.time}</div><div className="text-[10px] text-slate-500 uppercase">{item.label}</div></div>
                                        <div className="flex gap-1">
                                            <button onClick={()=>setScheduleModal({open:true, mode:'edit', data:item, day:item.day})} className="p-1.5 text-slate-500 hover:text-blue-400"><Edit2 size={14}/></button>
                                            <button onClick={()=>deleteDoc(doc(db,'artifacts',appId,'public','data','schedule',item.id))} className="p-1.5 text-slate-500 hover:text-red-500"><Trash2 size={14}/></button>
                                        </div>
                                    </div>
                                ))}
                             </div>
                        </div>
                    ))}
                </div>
            </div>
        )}
        {activeTab === 'sounds' && (
             <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-in fade-in">
                 {[...DEFAULT_SOUNDS, ...customSounds].map(s => (
                     <div key={s.id} className="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex justify-between items-center">
                         <div className="flex items-center gap-3"><div className="bg-slate-800 p-3 rounded-xl text-blue-400"><Music size={20}/></div><span className="font-bold text-sm truncate w-24">{s.name}</span></div>
                         <button onClick={()=>{ const a=new Audio(s.url); a.play(); }} className="p-2 hover:bg-slate-800 rounded-lg text-blue-400"><Play size={18}/></button>
                     </div>
                 ))}
             </div>
        )}
        {activeTab === 'users' && isStation && <UsersView />}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-slate-900/90 backdrop-blur-xl border-t border-slate-800 px-6 py-4 flex justify-around md:hidden z-50">
          <button onClick={() => setActiveTab('control')} className={`flex flex-col items-center gap-1 ${activeTab === 'control' ? 'text-blue-500' : 'text-slate-500'}`}><Volume2 size={24} /><span className="text-[9px] font-black uppercase">KONTROL</span></button>
          <button onClick={() => setActiveTab('planner')} className={`flex flex-col items-center gap-1 ${activeTab === 'planner' ? 'text-blue-500' : 'text-slate-500'}`}><Calendar size={24} /><span className="text-[9px] font-black uppercase">PROGRAM</span></button>
          {isStation && <button onClick={() => setActiveTab('users')} className={`flex flex-col items-center gap-1 ${activeTab === 'users' ? 'text-emerald-500' : 'text-slate-500'}`}><Users size={24} /><span className="text-[9px] font-black uppercase">ÜYELER</span></button>}
      </nav>
      {isStation && <div className="fixed bottom-24 right-6 bg-emerald-600 text-white p-4 rounded-3xl shadow-2xl flex items-center gap-4 z-50 animate-bounce"><Monitor size={24} /><div className="pr-4"><div className="font-black text-sm uppercase leading-none">İSTASYON MODU</div><div className="text-[10px] opacity-80 font-bold">Ses çıkışı aktif</div></div></div>}
    </div>
  );
}