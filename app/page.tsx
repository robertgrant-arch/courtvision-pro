'use client';

import dynamic from 'next/dynamic';
import React, {
  useRef, useEffect, useState, useCallback, useMemo
} from 'react';
import { create } from 'zustand';

// ─── Types ────────────────────────────────────────────────────────────────────

type Vec2 = { x: number; y: number };
type Vec3 = { x: number; y: number; z: number };
type TeamRole = 'offense' | 'defense';
type PathType = 'cut' | 'pass' | 'dribble' | 'screen';
type AppMode = 'coach' | '3d' | 'quiz';
type CameraPreset = 'broadcast' | 'overhead' | 'baseline' | 'sideline' | 'pov';

interface Player {
  id: string;
  label: string;
  role: TeamRole;
  pos2d: Vec2;   // 0-1 normalized on half-court canvas
  pos3d: Vec3;
}

interface PathSegment {
  id: string;
  playerId: string;
  type: PathType;
  points: Vec2[];
  color: string;
}

interface QuizQuestion {
  checkpoint: number; // 0-1 play progress
  question: string;
  choices: string[];
  correct: number;
  explanation: string;
}

interface Play {
  id: string;
  name: string;
  category: string;
  description: string;
  players: Player[];
  paths: PathSegment[];
  reads: string[];
  quiz: QuizQuestion[];
}

interface AppState {
  mode: AppMode;
  activePlayId: string;
  plays: Play[];
  selectedPlayerId: string | null;
  drawingPathType: PathType;
  currentPath: Vec2[];
  isDrawing: boolean;
  playProgress: number;       // 0-1
  isPlaying: boolean;
  playSpeed: number;          // 0.5 | 1 | 2
  cameraPreset: CameraPreset;
  quizScore: number;
  quizTotal: number;
  quizActive: boolean;
  quizQuestion: QuizQuestion | null;
  quizAnswered: boolean;
  quizSelectedAnswer: number | null;
  setMode: (m: AppMode) => void;
  setActivePlay: (id: string) => void;
  setSelectedPlayer: (id: string | null) => void;
  setDrawingPathType: (t: PathType) => void;
  addPathPoint: (p: Vec2) => void;
  commitPath: () => void;
  cancelPath: () => void;
  updatePlayerPos: (playId: string, playerId: string, pos: Vec2) => void;
  setPlayProgress: (v: number) => void;
  setIsPlaying: (v: boolean) => void;
  setPlaySpeed: (v: number) => void;
  setCameraPreset: (v: CameraPreset) => void;
  answerQuiz: (idx: number) => void;
  dismissQuiz: () => void;
  triggerQuizCheckpoint: (q: QuizQuestion) => void;
  resetPlay: () => void;
}

// ─── Pre-built Plays ──────────────────────────────────────────────────────────

const PLAYS: Play[] = [
  {
    id: 'horns-pnr',
    name: 'Horns PnR',
    category: 'Half Court',
    description: 'Two bigs at elbow, guard initiates pick-and-roll with either big.',
    players: [
      { id:'o1', label:'O1', role:'offense', pos2d:{x:.5,y:.85}, pos3d:{x:0,y:0,z:7} },
      { id:'o2', label:'O2', role:'offense', pos2d:{x:.25,y:.65}, pos3d:{x:-4,y:0,z:4} },
      { id:'o3', label:'O3', role:'offense', pos2d:{x:.75,y:.65}, pos3d:{x:4,y:0,z:4} },
      { id:'o4', label:'O4', role:'offense', pos2d:{x:.38,y:.45}, pos3d:{x:-2,y:0,z:1} },
      { id:'o5', label:'O5', role:'offense', pos2d:{x:.62,y:.45}, pos3d:{x:2,y:0,z:1} },
      { id:'x1', label:'X1', role:'defense', pos2d:{x:.5,y:.78}, pos3d:{x:0,y:0,z:6} },
      { id:'x2', label:'X2', role:'defense', pos2d:{x:.25,y:.58}, pos3d:{x:-4,y:0,z:3} },
      { id:'x3', label:'X3', role:'defense', pos2d:{x:.75,y:.58}, pos3d:{x:4,y:0,z:3} },
      { id:'x4', label:'X4', role:'defense', pos2d:{x:.38,y:.38}, pos3d:{x:-2,y:0,z:0} },
      { id:'x5', label:'X5', role:'defense', pos2d:{x:.62,y:.38}, pos3d:{x:2,y:0,z:0} },
    ],
    paths: [
      { id:'p1', playerId:'o1', type:'dribble', points:[{x:.5,y:.85},{x:.38,y:.72}], color:'#3b82f6' },
      { id:'p2', playerId:'o4', type:'screen', points:[{x:.38,y:.45},{x:.38,y:.65}], color:'#f97316' },
      { id:'p3', playerId:'o4', type:'cut', points:[{x:.38,y:.65},{x:.2,y:.45}], color:'#3b82f6' },
      { id:'p4', playerId:'o1', type:'pass', points:[{x:.38,y:.72},{x:.62,y:.45}], color:'#22c55e' },
    ],
    reads: [
      'O1 dribbles to left elbow; O4 sets ball screen',
      'Read: If X4 hedges hard → slip O4 to rim',
      'Read: If X1 goes under → O1 pulls up mid-range',
      'Skip pass available to O5 for 3-pointer',
    ],
    quiz: [
      { checkpoint:.4, question:'O4 sets the screen and X4 switches hard. What is the best read?', choices:['O1 drives baseline','O4 slips to the rim for lob','O1 kicks to corner 3','O2 cuts backdoor'], correct:1, explanation:'When the screener\'s defender switches early, the screener should slip (cut) before contact to receive a lob at the rim.' },
      { checkpoint:.75, question:'O1 turns the corner and X5 helps from the dunker spot. What should O5 do?', choices:['Stand still in corner','Cut to the rim','Pop to the 3-point line','Set another screen'], correct:2, explanation:'When the help defender leaves the dunker/corner, O5 pops to the now-open 3-point line for the kick-out.' },
    ],
  },
  {
    id: 'floppy',
    name: 'Floppy',
    category: 'Half Court',
    description: 'Wing players curl or fade off staggered screens based on defender position.',
    players: [
      { id:'o1', label:'O1', role:'offense', pos2d:{x:.5,y:.85}, pos3d:{x:0,y:0,z:7} },
      { id:'o2', label:'O2', role:'offense', pos2d:{x:.5,y:.5}, pos3d:{x:0,y:0,z:2} },
      { id:'o3', label:'O3', role:'offense', pos2d:{x:.5,y:.35}, pos3d:{x:0,y:0,z:0} },
      { id:'o4', label:'O4', role:'offense', pos2d:{x:.2,y:.55}, pos3d:{x:-5,y:0,z:3} },
      { id:'o5', label:'O5', role:'offense', pos2d:{x:.8,y:.55}, pos3d:{x:5,y:0,z:3} },
      { id:'x1', label:'X1', role:'defense', pos2d:{x:.5,y:.78}, pos3d:{x:0,y:0,z:6} },
      { id:'x2', label:'X2', role:'defense', pos2d:{x:.5,y:.43}, pos3d:{x:0,y:0,z:1} },
      { id:'x3', label:'X3', role:'defense', pos2d:{x:.5,y:.28}, pos3d:{x:0,y:0,z:-1} },
      { id:'x4', label:'X4', role:'defense', pos2d:{x:.2,y:.48}, pos3d:{x:-5,y:0,z:2} },
      { id:'x5', label:'X5', role:'defense', pos2d:{x:.8,y:.48}, pos3d:{x:5,y:0,z:2} },
    ],
    paths: [
      { id:'p1', playerId:'o2', type:'cut', points:[{x:.5,y:.5},{x:.25,y:.65}], color:'#3b82f6' },
      { id:'p2', playerId:'o3', type:'cut', points:[{x:.5,y:.35},{x:.75,y:.65}], color:'#3b82f6' },
      { id:'p3', playerId:'o1', type:'pass', points:[{x:.5,y:.85},{x:.25,y:.65}], color:'#22c55e' },
    ],
    reads: [
      'O2 and O3 start below baseline extended',
      'Read defender position: trail → curl tight off screen',
      'Read: Defender under screens → fade to corner',
      'O1 hits the cutter who reads their defender',
    ],
    quiz: [
      { checkpoint:.5, question:'X2 is trailing O2 over the screen. What should O2 do?', choices:['Fade to corner','Curl tight to basket','Stop and pop','Set a screen for O3'], correct:1, explanation:'When the defender trails over the top of the screen, the offensive player should curl tightly toward the basket where the defender cannot recover.' },
    ],
  },
  {
    id: 'spain-pnr',
    name: 'Spain PnR',
    category: 'BLOB / Set Play',
    description: 'Back-screen on the roller’s defender added to standard PnR, creating a 4-on-3.',
    players: [
      { id:'o1', label:'O1', role:'offense', pos2d:{x:.5,y:.85}, pos3d:{x:0,y:0,z:7} },
      { id:'o2', label:'O2', role:'offense', pos2d:{x:.2,y:.7}, pos3d:{x:-5,y:0,z:5} },
      { id:'o3', label:'O3', role:'offense', pos2d:{x:.8,y:.7}, pos3d:{x:5,y:0,z:5} },
      { id:'o4', label:'O4', role:'offense', pos2d:{x:.38,y:.45}, pos3d:{x:-2,y:0,z:1} },
      { id:'o5', label:'O5', role:'offense', pos2d:{x:.62,y:.6}, pos3d:{x:2,y:0,z:3} },
      { id:'x1', label:'X1', role:'defense', pos2d:{x:.5,y:.79}, pos3d:{x:0,y:0,z:6} },
      { id:'x2', label:'X2', role:'defense', pos2d:{x:.2,y:.63}, pos3d:{x:-5,y:0,z:4} },
      { id:'x3', label:'X3', role:'defense', pos2d:{x:.8,y:.63}, pos3d:{x:5,y:0,z:4} },
      { id:'x4', label:'X4', role:'defense', pos2d:{x:.38,y:.38}, pos3d:{x:-2,y:0,z:0} },
      { id:'x5', label:'X5', role:'defense', pos2d:{x:.62,y:.53}, pos3d:{x:2,y:0,z:2} },
    ],
    paths: [
      { id:'p1', playerId:'o1', type:'dribble', points:[{x:.5,y:.85},{x:.38,y:.72}], color:'#3b82f6' },
      { id:'p2', playerId:'o5', type:'screen', points:[{x:.62,y:.6},{x:.5,y:.72}], color:'#f97316' },
      { id:'p3', playerId:'o5', type:'cut', points:[{x:.5,y:.72},{x:.5,y:.45}], color:'#3b82f6' },
      { id:'p4', playerId:'o4', type:'screen', points:[{x:.38,y:.45},{x:.5,y:.55}], color:'#f97316' },
      { id:'p5', playerId:'o1', type:'pass', points:[{x:.38,y:.72},{x:.5,y:.45}], color:'#22c55e' },
    ],
    reads: [
      'O5 sets ball screen for O1 at left elbow',
      'O4 immediately back-screens X5 as O5 rolls',
      'X5 is blocked by O4 — O5 catches lob at rim',
      'Safety valve: skip to O3 in weak corner',
    ],
    quiz: [
      { checkpoint:.55, question:'X4 switches onto O5’s roll. X5 is caught on O4’s backscreen. What is the best action?', choices:['O1 pull-up jumper','Lob to O5 attacking smaller X4','Reset the play','O4 slips to the 3-point line'], correct:1, explanation:'The Spain PnR is designed to create a size mismatch on the roll man. With X5 screened away, O5 attacks smaller X4 at the rim via lob.' },
    ],
  },
  {
    id: 'ucla-cut',
    name: 'UCLA Cut',
    category: 'Motion',
    description: 'Guard-to-forward entry, guard cuts off high post for layup or kick-out.',
    players: [
      { id:'o1', label:'O1', role:'offense', pos2d:{x:.5,y:.85}, pos3d:{x:0,y:0,z:7} },
      { id:'o2', label:'O2', role:'offense', pos2d:{x:.2,y:.7}, pos3d:{x:-5,y:0,z:5} },
      { id:'o3', label:'O3', role:'offense', pos2d:{x:.8,y:.7}, pos3d:{x:5,y:0,z:5} },
      { id:'o4', label:'O4', role:'offense', pos2d:{x:.38,y:.5}, pos3d:{x:-2,y:0,z:2} },
      { id:'o5', label:'O5', role:'offense', pos2d:{x:.62,y:.42}, pos3d:{x:2,y:0,z:0.5} },
      { id:'x1', label:'X1', role:'defense', pos2d:{x:.5,y:.79}, pos3d:{x:0,y:0,z:6} },
      { id:'x2', label:'X2', role:'defense', pos2d:{x:.2,y:.63}, pos3d:{x:-5,y:0,z:4} },
      { id:'x3', label:'X3', role:'defense', pos2d:{x:.8,y:.63}, pos3d:{x:5,y:0,z:4} },
      { id:'x4', label:'X4', role:'defense', pos2d:{x:.38,y:.43}, pos3d:{x:-2,y:0,z:1} },
      { id:'x5', label:'X5', role:'defense', pos2d:{x:.62,y:.35}, pos3d:{x:2,y:0,z:-0.5} },
    ],
    paths: [
      { id:'p1', playerId:'o1', type:'pass', points:[{x:.5,y:.85},{x:.38,y:.5}], color:'#22c55e' },
      { id:'p2', playerId:'o1', type:'cut', points:[{x:.5,y:.85},{x:.38,y:.6},{x:.5,y:.42}], color:'#3b82f6' },
      { id:'p3', playerId:'o4', type:'pass', points:[{x:.38,y:.5},{x:.5,y:.42}], color:'#22c55e' },
    ],
    reads: [
      'O1 passes to O4 at high post',
      'O1 immediately cuts off O4’s shoulder toward basket',
      'Read: If X1 trails → O4 drops pass for layup',
      'If cut denied → O4 attacks, O1 spaces to corner',
    ],
    quiz: [
      { checkpoint:.45, question:'X1 goes behind O4 (under the screen). What should O4 do?', choices:['Pass to O1 for layup','Drive baseline','Kick out to O2','Hold and wait'], correct:0, explanation:'If X1 goes under the high post screen, O1 is open cutting to the basket. O4 makes the drop pass for the easy layup.' },
    ],
  },
  {
    id: 'elevator',
    name: 'Elevator Screen',
    category: 'Set Play',
    description: 'Two screeners "close the elevator doors" on a shooter sprinting through the lane.',
    players: [
      { id:'o1', label:'O1', role:'offense', pos2d:{x:.5,y:.85}, pos3d:{x:0,y:0,z:7} },
      { id:'o2', label:'O2', role:'offense', pos2d:{x:.15,y:.55}, pos3d:{x:-6,y:0,z:3} },
      { id:'o3', label:'O3', role:'offense', pos2d:{x:.5,y:.55}, pos3d:{x:0,y:0,z:2.5} },
      { id:'o4', label:'O4', role:'offense', pos2d:{x:.38,y:.42}, pos3d:{x:-2,y:0,z:0.5} },
      { id:'o5', label:'O5', role:'offense', pos2d:{x:.62,y:.42}, pos3d:{x:2,y:0,z:0.5} },
      { id:'x1', label:'X1', role:'defense', pos2d:{x:.5,y:.79}, pos3d:{x:0,y:0,z:6} },
      { id:'x2', label:'X2', role:'defense', pos2d:{x:.15,y:.48}, pos3d:{x:-6,y:0,z:2} },
      { id:'x3', label:'X3', role:'defense', pos2d:{x:.5,y:.48}, pos3d:{x:0,y:0,z:1.5} },
      { id:'x4', label:'X4', role:'defense', pos2d:{x:.38,y:.35}, pos3d:{x:-2,y:0,z:-0.5} },
      { id:'x5', label:'X5', role:'defense', pos2d:{x:.62,y:.35}, pos3d:{x:2,y:0,z:-0.5} },
    ],
    paths: [
      { id:'p1', playerId:'o2', type:'cut', points:[{x:.15,y:.55},{x:.4,y:.55},{x:.82,y:.7}], color:'#3b82f6' },
      { id:'p2', playerId:'o4', type:'screen', points:[{x:.38,y:.42},{x:.4,y:.55}], color:'#f97316' },
      { id:'p3', playerId:'o5', type:'screen', points:[{x:.62,y:.42},{x:.6,y:.55}], color:'#f97316' },
      { id:'p4', playerId:'o1', type:'pass', points:[{x:.5,y:.85},{x:.82,y:.7}], color:'#22c55e' },
    ],
    reads: [
      'O4 and O5 stand at free-throw lane width, facing out',
      'O2 sprints through the lane as screens close behind',
      'O1 times the pass to O2 as they emerge for the 3',
      'If X2 beats screens: O3 re-screens or O2 continues cut',
    ],
    quiz: [
      { checkpoint:.6, question:'O2 comes off the elevator screen but X2 fought through both screens. What is the best option?', choices:['O2 shoots anyway','O2 continues cut to corner, O3 re-screens','O1 drives','O4 seals for post-up'], correct:1, explanation:'If the defender successfully navigates the elevator screens, the shooter should keep moving to the corner while a re-screen is set, or convert the cut into a backdoor opportunity.' },
    ],
  },
  {
    id: 'hammer',
    name: 'Hammer Action',
    category: 'BLOB / Set Play',
    description: 'Corner shooter gets a back-screen ("hammer") while attention is on ball-screen.',
    players: [
      { id:'o1', label:'O1', role:'offense', pos2d:{x:.5,y:.85}, pos3d:{x:0,y:0,z:7} },
      { id:'o2', label:'O2', role:'offense', pos2d:{x:.82,y:.62}, pos3d:{x:5,y:0,z:4} },
      { id:'o3', label:'O3', role:'offense', pos2d:{x:.82,y:.45}, pos3d:{x:6,y:0,z:1} },
      { id:'o4', label:'O4', role:'offense', pos2d:{x:.38,y:.5}, pos3d:{x:-2,y:0,z:2} },
      { id:'o5', label:'O5', role:'offense', pos2d:{x:.62,y:.62}, pos3d:{x:2,y:0,z:3.5} },
      { id:'x1', label:'X1', role:'defense', pos2d:{x:.5,y:.79}, pos3d:{x:0,y:0,z:6} },
      { id:'x2', label:'X2', role:'defense', pos2d:{x:.82,y:.55}, pos3d:{x:5,y:0,z:3} },
      { id:'x3', label:'X3', role:'defense', pos2d:{x:.82,y:.38}, pos3d:{x:6,y:0,z:0} },
      { id:'x4', label:'X4', role:'defense', pos2d:{x:.38,y:.43}, pos3d:{x:-2,y:0,z:1} },
      { id:'x5', label:'X5', role:'defense', pos2d:{x:.62,y:.55}, pos3d:{x:2,y:0,z:2.5} },
    ],
    paths: [
      { id:'p1', playerId:'o1', type:'dribble', points:[{x:.5,y:.85},{x:.38,y:.72}], color:'#3b82f6' },
      { id:'p2', playerId:'o5', type:'screen', points:[{x:.62,y:.62},{x:.5,y:.72}], color:'#f97316' },
      { id:'p3', playerId:'o2', type:'screen', points:[{x:.82,y:.62},{x:.82,y:.5}], color:'#f97316' },
      { id:'p4', playerId:'o3', type:'cut', points:[{x:.82,y:.45},{x:.82,y:.62},{x:.7,y:.75}], color:'#3b82f6' },
      { id:'p5', playerId:'o1', type:'pass', points:[{x:.38,y:.72},{x:.7,y:.75}], color:'#22c55e' },
    ],
    reads: [
      'O1 initiates ball screen with O5 at the elbow',
      'While defense focuses on PnR, O2 back-screens X3',
      'O3 cuts off hammer screen to weak-side corner',
      'O1 hits O3 for open 3 — defense caught in rotation',
    ],
    quiz: [
      { checkpoint:.5, question:'X3 is cheating on the Hammer screen by hedging early. What adjustment should O3 make?', choices:['Still cut to corner','Backdoor cut to basket','Set a new screen','Hold position in corner'], correct:1, explanation:'If the defender cheats toward where the cutter is going, the cutter should counter with a backdoor cut in the opposite direction, attacking the baseline toward the rim.' },
    ],
  },
];

// ─── Zustand Store ────────────────────────────────────────────────────────────

const useStore = create<AppState>((set, get) => ({
  mode: 'coach',
  activePlayId: 'horns-pnr',
  plays: PLAYS,
  selectedPlayerId: null,
  drawingPathType: 'cut',
  currentPath: [],
  isDrawing: false,
  playProgress: 0,
  isPlaying: false,
  playSpeed: 1,
  cameraPreset: 'broadcast',
  quizScore: 0,
  quizTotal: 0,
  quizActive: false,
  quizQuestion: null,
  quizAnswered: false,
  quizSelectedAnswer: null,

  setMode: (m) => set({ mode: m, isPlaying: false, playProgress: 0 }),
  setActivePlay: (id) => set({ activePlayId: id, selectedPlayerId: null, isPlaying: false, playProgress: 0, currentPath: [], isDrawing: false }),
  setSelectedPlayer: (id) => set({ selectedPlayerId: id }),
  setDrawingPathType: (t) => set({ drawingPathType: t }),
  addPathPoint: (p) => {
    const st = get();
    if (!st.isDrawing) {
      set({ isDrawing: true, currentPath: [p] });
    } else {
      set({ currentPath: [...st.currentPath, p] });
    }
  },
  commitPath: () => {
    const st = get();
    if (!st.selectedPlayerId || st.currentPath.length < 2) { set({ isDrawing: false, currentPath: [] }); return; }
    const play = st.plays.find(p => p.id === st.activePlayId);
    if (!play) return;
    const newPath: PathSegment = {
      id: `custom-${Date.now()}`,
      playerId: st.selectedPlayerId,
      type: st.drawingPathType,
      points: st.currentPath,
      color: st.drawingPathType === 'pass' ? '#22c55e' : st.drawingPathType === 'screen' ? '#f97316' : '#3b82f6',
    };
    const updatedPlay = { ...play, paths: [...play.paths, newPath] };
    set({ plays: st.plays.map(p => p.id === st.activePlayId ? updatedPlay : p), isDrawing: false, currentPath: [] });
  },
  cancelPath: () => set({ isDrawing: false, currentPath: [] }),
  updatePlayerPos: (playId, playerId, pos) => {
    const st = get();
    set({
      plays: st.plays.map(pl => pl.id === playId
        ? { ...pl, players: pl.players.map(p => p.id === playerId ? { ...p, pos2d: pos } : p) }
        : pl)
    });
  },
  setPlayProgress: (v) => set({ playProgress: v }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setPlaySpeed: (v) => set({ playSpeed: v }),
  setCameraPreset: (v) => set({ cameraPreset: v }),
  answerQuiz: (idx) => {
    const st = get();
    if (!st.quizQuestion) return;
    const correct = idx === st.quizQuestion.correct;
    set({
      quizAnswered: true,
      quizSelectedAnswer: idx,
      quizScore: correct ? st.quizScore + 1 : st.quizScore,
      quizTotal: st.quizTotal + 1,
    });
  },
  dismissQuiz: () => set({ quizActive: false, quizQuestion: null, quizAnswered: false, quizSelectedAnswer: null, isPlaying: true }),
  triggerQuizCheckpoint: (q) => set({ quizActive: true, quizQuestion: q, isPlaying: false, quizAnswered: false, quizSelectedAnswer: null }),
  resetPlay: () => set({ playProgress: 0, isPlaying: false }),
}));

// ─── Court Dimensions (2D canvas) ────────────────────────────────────────────
// We model an NBA half-court: 47ft wide × 47ft from baseline to half-court
// Canvas is 560×520; players placed in 0-1 normalized space.

const CW = 560, CH = 520; // canvas width/height

function norm2canvas(p: Vec2): Vec2 { return { x: p.x * CW, y: p.y * CH }; }
function canvas2norm(p: Vec2): Vec2 { return { x: p.x / CW, y: p.y / CH }; }

// ─── 2D Court Canvas ─────────────────────────────────────────────────────────

function CourtCanvas2D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const {
    plays, activePlayId, selectedPlayerId, drawingPathType,
    currentPath, isDrawing, playProgress,
    addPathPoint, commitPath, cancelPath,
    setSelectedPlayer, updatePlayerPos, isPlaying
  } = useStore();

  const play = plays.find(p => p.id === activePlayId)!;
  const draggingRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const drawCourt = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.clearRect(0, 0, CW, CH);

    // Floor
    ctx.fillStyle = '#b8864e';
    ctx.fillRect(0, 0, CW, CH);

    // Court lines
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;

    // Boundary
    ctx.strokeRect(20, 10, CW - 40, CH - 20);

    // Paint / key (roughly proportional)
    const paintW = 160, paintH = 190;
    const px = (CW - paintW) / 2;
    ctx.strokeRect(px, CH - paintH - 10, paintW, paintH);

    // Free-throw line
    ctx.beginPath(); ctx.moveTo(px, CH - paintH - 10); ctx.lineTo(px + paintW, CH - paintH - 10); ctx.stroke();

    // FT circle
    ctx.beginPath();
    ctx.arc(CW / 2, CH - paintH - 10, paintW / 2, Math.PI, 0);
    ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);

    // Restricted arc
    ctx.beginPath();
    ctx.arc(CW / 2, CH - 10, 40, Math.PI, 0);
    ctx.stroke();

    // Backboard & rim
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(CW / 2 - 30, CH - 12); ctx.lineTo(CW / 2 + 30, CH - 12); ctx.stroke();
    ctx.beginPath();
    ctx.arc(CW / 2, CH - 12, 14, Math.PI, 0);
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.stroke();

    // 3-point arc
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
    const r3 = 238;
    const cX = CW / 2, cY = CH - 10;
    const ang = Math.asin((CW - 40 - cX - 20) / r3);  // corner 3 point
    ctx.beginPath();
    ctx.moveTo(20, CH - 10 - 90); // corner 3 left
    ctx.lineTo(20, CH - 10 - 90);
    ctx.arc(cX, cY, r3, Math.PI - ang + 0.02, ang - 0.02, false);
    ctx.lineTo(CW - 20, CH - 10 - 90);
    ctx.stroke();

    // Corner 3 lines
    ctx.beginPath(); ctx.moveTo(20, CH - 10); ctx.lineTo(20, CH - 10 - 90); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CW - 20, CH - 10); ctx.lineTo(CW - 20, CH - 10 - 90); ctx.stroke();

    // Half-court line
    ctx.beginPath(); ctx.moveTo(20, 10); ctx.lineTo(CW - 20, 10);
    ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
  }, []);

  const drawPaths = useCallback((ctx: CanvasRenderingContext2D, paths: PathSegment[], alpha = 1) => {
    for (const path of paths) {
      if (path.points.length < 2) continue;
      const pts = path.points.map(norm2canvas);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = path.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash(path.type === 'pass' ? [8, 4] : path.type === 'screen' ? [0] : []);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow at end
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
      ctx.fillStyle = path.color;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x - 10 * Math.cos(ang - 0.4), last.y - 10 * Math.sin(ang - 0.4));
      ctx.lineTo(last.x - 10 * Math.cos(ang + 0.4), last.y - 10 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }, []);

  const drawAnimatedPaths = useCallback((ctx: CanvasRenderingContext2D, paths: PathSegment[], progress: number) => {
    for (const path of paths) {
      if (path.points.length < 2) continue;
      const pts = path.points.map(norm2canvas);
      // Draw partial path based on progress
      const totalLen = pts.reduce((acc, p, i) => {
        if (i === 0) return 0;
        const dx = p.x - pts[i-1].x, dy = p.y - pts[i-1].y;
        return acc + Math.sqrt(dx*dx+dy*dy);
      }, 0);
      const drawn = totalLen * progress;
      let rem = drawn;
      ctx.strokeStyle = path.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash(path.type === 'pass' ? [8, 4] : []);
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
        const seg = Math.sqrt(dx*dx+dy*dy);
        if (rem <= 0) break;
        if (rem >= seg) { ctx.lineTo(pts[i].x, pts[i].y); rem -= seg; }
        else { ctx.lineTo(pts[i-1].x + dx*(rem/seg), pts[i-1].y + dy*(rem/seg)); rem = 0; }
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
  }, []);

  const drawPlayers = useCallback((ctx: CanvasRenderingContext2D, players: Player[], selectedId: string | null) => {
    for (const pl of players) {
      const c = norm2canvas(pl.pos2d);
      const isOff = pl.role === 'offense';
      const isSel = pl.id === selectedId;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 18, 0, Math.PI * 2);
      ctx.fillStyle = isOff ? '#1d4ed8' : '#dc2626';
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pl.label, c.x, c.y);
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    drawCourt(ctx);
    if (isPlaying || playProgress > 0) {
      drawAnimatedPaths(ctx, play.paths, playProgress);
    } else {
      drawPaths(ctx, play.paths);
    }
    if (isDrawing && currentPath.length > 0) {
      const pts = currentPath.map(norm2canvas);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke(); ctx.setLineDash([]);
    }
    drawPlayers(ctx, play.players, selectedPlayerId);
  }, [play, selectedPlayerId, currentPath, isDrawing, playProgress, isPlaying, drawCourt, drawPaths, drawPlayers, drawAnimatedPaths]);

  const getPlayerAt = (x: number, y: number): Player | null => {
    for (const pl of play.players) {
      const c = norm2canvas(pl.pos2d);
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < 20) return pl;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const pl = getPlayerAt(x, y);
    if (pl) {
      const c = norm2canvas(pl.pos2d);
      draggingRef.current = { id: pl.id, offsetX: x - c.x, offsetY: y - c.y };
      setSelectedPlayer(pl.id);
    } else {
      setSelectedPlayer(null);
      addPathPoint(canvas2norm({ x, y }));
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left - draggingRef.current.offsetX;
    const y = e.clientY - rect.top - draggingRef.current.offsetY;
    updatePlayerPos(activePlayId, draggingRef.current.id, canvas2norm({ x, y }));
  };

  const onMouseUp = () => { draggingRef.current = null; };

  const onDblClick = (e: React.MouseEvent) => {
    if (isDrawing) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      addPathPoint(canvas2norm({ x, y }));
      commitPath();
    }
  };

  const onContextMenu = (e: React.MouseEvent) => { e.preventDefault(); cancelPath(); };

  return (
    <canvas
      ref={canvasRef}
      width={CW}
      height={CH}
      className="rounded-xl shadow-2xl cursor-crosshair"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onDoubleClick={onDblClick}
      onContextMenu={onContextMenu}
    />
  );
}

// ─── 3D Scene (dynamically imported) ─────────────────────────────────────────

const ThreeDView = dynamic(() => Promise.resolve(ThreeDScene), { ssr: false });

function ThreeDScene() {
  // Lazy import three libs at module level (safe because dynamic import)
  const { Canvas, useFrame } = require('@react-three/fiber');
  const { OrbitControls, Environment, PerspectiveCamera } = require('@react-three/drei');
  const THREE = require('three');

  const { plays, activePlayId, playProgress, cameraPreset, isPlaying } = useStore();
  const play = plays.find(p => p.id === activePlayId)!;

  const camPresets: Record<CameraPreset, [number, number, number]> = {
    broadcast: [12, 10, 18],
    overhead: [0, 22, 0.1],
    baseline: [0, 4, -2],
    sideline: [20, 6, 6],
    pov: [0, 2, 12],
  };

  function Court3D() {
    return (
      <group>
        {/* Floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[28, 15]} />
          <meshStandardMaterial color="#c8874a" roughness={0.8} />
        </mesh>
        {/* Paint */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, -2.5]}>
          <planeGeometry args={[4.9, 5.8]} />
          <meshStandardMaterial color="#b07840" roughness={0.8} />
        </mesh>
        {/* Backboard */}
        <mesh position={[0, 3.05, -6.7]}>
          <boxGeometry args={[1.83, 1.07, 0.05]} />
          <meshStandardMaterial color="white" transparent opacity={0.9} />
        </mesh>
        {/* Rim */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 3.05, -6.02]}>
          <torusGeometry args={[0.23, 0.02, 8, 32]} />
          <meshStandardMaterial color="#ef4444" />
        </mesh>
        {/* Lines */}
        {[
          // Boundary
          <mesh key="line-bound" rotation={[-Math.PI/2,0,0]} position={[0,0.02,0]}>
            <edgesGeometry args={[new THREE.BoxGeometry(13.72,0,14.32)]} />
          </mesh>
        ]}
        {/* Three-point arc (visual only) */}
        <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0.02, -5]}>
          <ringGeometry args={[6.7, 6.75, 64, 1, 0, Math.PI]} />
          <meshBasicMaterial color="white" opacity={0.8} transparent />
        </mesh>
        {/* FT circle */}
        <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0.02, -2.8]}>
          <ringGeometry args={[1.8, 1.85, 64]} />
          <meshBasicMaterial color="white" opacity={0.6} transparent />
        </mesh>
        {/* Center circle */}
        <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, 0.02, 7]}>
          <ringGeometry args={[1.8, 1.85, 64]} />
          <meshBasicMaterial color="white" opacity={0.4} transparent />
        </mesh>
      </group>
    );
  }

  function Player3D({ player, progress }: { player: Player; progress: number }) {
    const meshRef = useRef<any>(null);
    const isOff = player.role === 'offense';

    // Interpolate position along their path
    const play2 = plays.find(p => p.id === activePlayId)!;
    const paths = play2.paths.filter(p => p.playerId === player.id);

    const getPos = (prog: number): [number, number, number] => {
      if (!paths.length) return [player.pos3d.x, 0, player.pos3d.z];
      const path = paths[0];
      if (path.points.length < 2) return [player.pos3d.x, 0, player.pos3d.z];
      // Map 2D path to 3D: x=x*13.72-6.86, z=y*14.32-14.32 (half-court)
      const pts3 = path.points.map((p: Vec2) => ({
        x: p.x * 13.72 - 6.86,
        z: p.y * 14.32 - 14.32 + 7.16,
      }));
      const idx = Math.min(Math.floor(prog * (pts3.length - 1)), pts3.length - 2);
      const t = (prog * (pts3.length - 1)) - idx;
      const a = pts3[idx], b = pts3[idx + 1];
      return [a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t];
    };

    useFrame(() => {
      if (!meshRef.current) return;
      const [px, py, pz] = getPos(progress);
      meshRef.current.position.set(px, py, pz);
    });

    const initPos = getPos(0);

    return (
      <group ref={meshRef} position={initPos}>
        {/* Body */}
        <mesh position={[0, 0.7, 0]} castShadow>
          <cylinderGeometry args={[0.22, 0.22, 0.9, 12]} />
          <meshStandardMaterial color={isOff ? '#1d4ed8' : '#dc2626'} />
        </mesh>
        {/* Head */}
        <mesh position={[0, 1.35, 0]} castShadow>
          <sphereGeometry args={[0.22, 16, 16]} />
          <meshStandardMaterial color={isOff ? '#93c5fd' : '#fca5a5'} />
        </mesh>
        {/* Jersey number label via sprite */}
        <sprite position={[0, 1.8, 0]} scale={[0.5, 0.25, 1]}>
          <spriteMaterial color={isOff ? '#3b82f6' : '#ef4444'} />
        </sprite>
      </group>
    );
  }

  function CameraRig() {
    const { camera } = require('@react-three/fiber').useThree();
    const target = camPresets[cameraPreset];
    useFrame(() => {
      camera.position.lerp(new THREE.Vector3(...target), 0.05);
      camera.lookAt(0, 0, 0);
    });
    return null;
  }

  return (
    <div className="w-full h-full">
      <Canvas shadows>
        <CameraRig />
        <PerspectiveCamera makeDefault position={camPresets.broadcast} fov={55} />
        <OrbitControls enablePan={false} maxPolarAngle={Math.PI / 2} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 10, 5]} intensity={1.2} castShadow />
        <pointLight position={[0, 8, 0]} intensity={0.5} />
        <Court3D />
        {play.players.map(pl => (
          <Player3D key={pl.id} player={pl} progress={playProgress} />
        ))}
        <fog attach="fog" args={['#1a1a2e', 20, 60]} />
      </Canvas>
    </div>
  );
}

// ─── Playback Controls ────────────────────────────────────────────────────────

function PlaybackControls() {
  const {
    plays, activePlayId, playProgress, isPlaying, playSpeed, mode,
    setPlayProgress, setIsPlaying, setPlaySpeed, resetPlay,
    triggerQuizCheckpoint, quizActive
  } = useStore();

  const play = plays.find(p => p.id === activePlayId)!;
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const triggeredCheckpoints = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!isPlaying || quizActive) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = null;
      return;
    }

    const tick = (now: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      const speed = 0.12 * playSpeed;
      setPlayProgress(Math.min(playProgress + dt * speed, 1));

      // Quiz checkpoint check (only in quiz mode)
      if (mode === 'quiz') {
        for (const q of play.quiz) {
          if (!triggeredCheckpoints.current.has(q.checkpoint) && playProgress >= q.checkpoint) {
            triggeredCheckpoints.current.add(q.checkpoint);
            triggerQuizCheckpoint(q);
            return;
          }
        }
      }

      if (playProgress >= 1) {
        setIsPlaying(false);
        lastTimeRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, playProgress, playSpeed, quizActive, mode, play.quiz, setPlayProgress, setIsPlaying, triggerQuizCheckpoint]);

  useEffect(() => {
    triggeredCheckpoints.current = new Set();
  }, [activePlayId]);

  return (
    <div className="flex items-center gap-3 bg-panel rounded-xl px-4 py-3 border border-white/10">
      <button
        onClick={resetPlay}
        className="text-white/70 hover:text-white transition-colors"
        title="Rewind"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
        </svg>
      </button>
      <button
        onClick={() => setIsPlaying(!isPlaying)}
        className="w-10 h-10 rounded-full bg-orange-500 hover:bg-orange-400 flex items-center justify-center transition-colors shadow-lg"
      >
        {isPlaying ? (
          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex-1 relative">
        <input
          type="range" min={0} max={1} step={0.001} value={playProgress}
          onChange={e => { setPlayProgress(parseFloat(e.target.value)); setIsPlaying(false); }}
          className="w-full accent-orange-500"
        />
        {mode === 'quiz' && play.quiz.map(q => (
          <div
            key={q.checkpoint}
            style={{ left: `${q.checkpoint * 100}%` }}
            className="absolute top-0 w-2 h-2 bg-yellow-400 rounded-full -translate-x-1 -translate-y-1"
            title="Quiz checkpoint"
          />
        ))}
      </div>
      <div className="flex gap-1">
        {[0.5, 1, 2].map(s => (
          <button
            key={s}
            onClick={() => setPlaySpeed(s)}
            className={`px-2 py-1 rounded text-xs font-bold transition-colors ${playSpeed === s ? 'bg-orange-500 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'}`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Quiz Overlay ─────────────────────────────────────────────────────────────

function QuizOverlay() {
  const { quizActive, quizQuestion, quizAnswered, quizSelectedAnswer, quizScore, quizTotal, answerQuiz, dismissQuiz } = useStore();
  if (!quizActive || !quizQuestion) return null;

  return (
    <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50 rounded-xl backdrop-blur-sm">
      <div className="bg-panel border border-orange-500/50 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white font-bold text-sm">?</div>
          <span className="text-orange-400 font-bold text-sm uppercase tracking-wider">Play Quiz</span>
          <span className="ml-auto text-white/50 text-sm">{quizScore}/{quizTotal}</span>
        </div>
        <p className="text-white font-semibold text-base mb-4 leading-relaxed">{quizQuestion.question}</p>
        <div className="space-y-2 mb-4">
          {quizQuestion.choices.map((c, i) => {
            let cls = 'w-full text-left px-4 py-3 rounded-lg border transition-all text-sm ';
            if (!quizAnswered) {
              cls += 'border-white/20 bg-white/5 hover:bg-white/10 hover:border-orange-400 text-white';
            } else if (i === quizQuestion.correct) {
              cls += 'border-green-500 bg-green-500/20 text-green-300';
            } else if (i === quizSelectedAnswer) {
              cls += 'border-red-500 bg-red-500/20 text-red-300';
            } else {
              cls += 'border-white/10 bg-white/5 text-white/40';
            }
            return (
              <button key={i} className={cls} onClick={() => !quizAnswered && answerQuiz(i)}>
                <span className="font-bold mr-2">{String.fromCharCode(65+i)}.</span>{c}
              </button>
            );
          })}
        </div>
        {quizAnswered && (
          <>
            <div className={`p-3 rounded-lg mb-4 text-sm ${quizSelectedAnswer === quizQuestion.correct ? 'bg-green-500/20 text-green-300 border border-green-500/50' : 'bg-red-500/20 text-red-300 border border-red-500/50'}`}>
              <span className="font-bold">{quizSelectedAnswer === quizQuestion.correct ? '✓ Correct! ' : '✗ Incorrect. '}</span>
              {quizQuestion.explanation}
            </div>
            <button onClick={dismissQuiz} className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold py-2 rounded-lg transition-colors">
              Continue Play →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Left Sidebar ─────────────────────────────────────────────────────────────

function LeftSidebar() {
  const { plays, activePlayId, setActivePlay, mode, setMode } = useStore();
  const categories = [...new Set(plays.map(p => p.category))];

  return (
    <aside className="w-60 bg-panel border-r border-white/10 flex flex-col h-full overflow-hidden">
      {/* Logo */}
      <div className="p-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="1.5" fill="none"/>
              <path d="M12 2C12 2 16 7 16 12C16 17 12 22 12 22" stroke="white" strokeWidth="1.5"/>
              <path d="M2 12H22" stroke="white" strokeWidth="1.5"/>
              <path d="M4.9 6C4.9 6 8 9 12 9C16 9 19.1 6 19.1 6" stroke="white" strokeWidth="1"/>
              <path d="M4.9 18C4.9 18 8 15 12 15C16 15 19.1 18 19.1 18" stroke="white" strokeWidth="1"/>
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-sm">CourtVision</div>
            <div className="text-orange-400 text-xs font-semibold">PRO</div>
          </div>
        </div>
      </div>

      {/* Mode switcher */}
      <div className="p-3 border-b border-white/10">
        <div className="grid grid-cols-3 gap-1 bg-black/30 rounded-lg p-1">
          {(['coach', '3d', 'quiz'] as AppMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`py-1.5 rounded-md text-xs font-semibold transition-all capitalize ${mode === m ? 'bg-orange-500 text-white shadow-md' : 'text-white/50 hover:text-white'}`}
            >
              {m === '3d' ? '3D' : m}
            </button>
          ))}
        </div>
      </div>

      {/* Play library */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {categories.map(cat => (
          <div key={cat}>
            <div className="text-white/40 text-xs font-bold uppercase tracking-widest mb-2 px-1">{cat}</div>
            <div className="space-y-1">
              {plays.filter(p => p.category === cat).map(pl => (
                <button
                  key={pl.id}
                  onClick={() => setActivePlay(pl.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-all group ${activePlayId === pl.id ? 'bg-orange-500/20 border border-orange-500/50' : 'hover:bg-white/5 border border-transparent'}`}
                >
                  <div className={`text-sm font-semibold ${activePlayId === pl.id ? 'text-orange-300' : 'text-white/80 group-hover:text-white'}`}>{pl.name}</div>
                  <div className="text-white/40 text-xs mt-0.5 line-clamp-1">{pl.description.split('.')[0]}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Score (quiz mode) */}
      {mode === 'quiz' && (
        <div className="p-4 border-t border-white/10 bg-black/20">
          <div className="text-xs text-white/50 mb-1">Quiz Score</div>
          <QuizScoreBar />
        </div>
      )}
    </aside>
  );
}

function QuizScoreBar() {
  const { quizScore, quizTotal } = useStore();
  const pct = quizTotal > 0 ? (quizScore / quizTotal) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-sm font-bold mb-1">
        <span className="text-orange-400">{quizScore}</span>
        <span className="text-white/50">/{quizTotal}</span>
      </div>
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-orange-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Right Sidebar ────────────────────────────────────────────────────────────

function RightSidebar() {
  const { plays, activePlayId, selectedPlayerId, drawingPathType, setDrawingPathType, mode, cameraPreset, setCameraPreset, cancelPath, isDrawing } = useStore();
  const play = plays.find(p => p.id === activePlayId)!;
  const selectedPlayer = play.players.find(p => p.id === selectedPlayerId);

  const pathTypes: { type: PathType; label: string; color: string; dash: string }[] = [
    { type: 'cut', label: 'Cut', color: '#3b82f6', dash: 'solid' },
    { type: 'pass', label: 'Pass', color: '#22c55e', dash: 'dashed' },
    { type: 'dribble', label: 'Dribble', color: '#a855f7', dash: 'solid' },
    { type: 'screen', label: 'Screen', color: '#f97316', dash: 'solid' },
  ];

  const cameras: { key: CameraPreset; label: string; icon: string }[] = [
    { key: 'broadcast', label: 'Broadcast', icon: '📺' },
    { key: 'overhead', label: 'Overhead', icon: '🔭' },
    { key: 'baseline', label: 'Baseline', icon: '🏀' },
    { key: 'sideline', label: 'Sideline', icon: '📐' },
    { key: 'pov', label: 'Player POV', icon: '👁️' },
  ];

  return (
    <aside className="w-56 bg-panel border-l border-white/10 flex flex-col h-full overflow-y-auto">
      {/* Play info */}
      <div className="p-4 border-b border-white/10">
        <div className="text-xs text-white/40 uppercase tracking-widest mb-1">Active Play</div>
        <div className="text-white font-bold text-base">{play.name}</div>
        <div className="text-white/50 text-xs mt-1">{play.category}</div>
      </div>

      {/* Coach tools */}
      {mode === 'coach' && (
        <div className="p-4 border-b border-white/10">
          <div className="text-xs text-white/40 uppercase tracking-widest mb-3">Draw Path</div>
          <div className="grid grid-cols-2 gap-2">
            {pathTypes.map(pt => (
              <button
                key={pt.type}
                onClick={() => setDrawingPathType(pt.type)}
                className={`px-2 py-2 rounded-lg text-xs font-semibold transition-all border ${drawingPathType === pt.type ? 'border-orange-500 bg-orange-500/20 text-orange-300' : 'border-white/10 text-white/60 hover:border-white/30 hover:text-white'}`}
                style={{ borderLeftColor: pt.color, borderLeftWidth: 3 }}
              >
                {pt.label}
              </button>
            ))}
          </div>
          {isDrawing && (
            <div className="mt-3 p-2 bg-orange-500/10 border border-orange-500/30 rounded-lg text-xs text-orange-300">
              <div className="font-semibold mb-1">Drawing mode active</div>
              <div>Click to add points</div>
              <div>Double-click to finish</div>
              <button onClick={cancelPath} className="mt-2 text-red-400 hover:text-red-300 underline">Cancel</button>
            </div>
          )}
          {selectedPlayer && (
            <div className="mt-3 p-2 bg-white/5 rounded-lg">
              <div className="text-xs text-white/40 mb-1">Selected Player</div>
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold ${selectedPlayer.role === 'offense' ? 'bg-blue-600' : 'bg-red-600'}`}>
                  {selectedPlayer.label}
                </div>
                <div>
                  <div className="text-white text-xs font-semibold">{selectedPlayer.label}</div>
                  <div className="text-white/40 text-xs capitalize">{selectedPlayer.role}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Camera presets (3D mode) */}
      {mode === '3d' && (
        <div className="p-4 border-b border-white/10">
          <div className="text-xs text-white/40 uppercase tracking-widest mb-3">Camera Angle</div>
          <div className="space-y-1">
            {cameras.map(cam => (
              <button
                key={cam.key}
                onClick={() => setCameraPreset(cam.key)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${cameraPreset === cam.key ? 'bg-orange-500/20 text-orange-300 border border-orange-500/50' : 'text-white/60 hover:text-white hover:bg-white/5 border border-transparent'}`}
              >
                <span className="mr-2">{cam.icon}</span>{cam.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Reads */}
      <div className="p-4 border-b border-white/10 flex-1">
        <div className="text-xs text-white/40 uppercase tracking-widest mb-3">Coach Reads</div>
        <ol className="space-y-2">
          {play.reads.map((r, i) => (
            <li key={i} className="flex gap-2 text-xs text-white/70 leading-relaxed">
              <span className="text-orange-400 font-bold shrink-0 mt-0.5">{i + 1}.</span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Legend */}
      <div className="p-4">
        <div className="text-xs text-white/40 uppercase tracking-widest mb-3">Legend</div>
        <div className="space-y-1.5">
          {[
            { color: '#3b82f6', label: 'Cut / Move', dash: false },
            { color: '#22c55e', label: 'Pass', dash: true },
            { color: '#a855f7', label: 'Dribble', dash: false },
            { color: '#f97316', label: 'Screen', dash: false },
          ].map(l => (
            <div key={l.label} className="flex items-center gap-2">
              <div className="w-8 h-0.5 relative" style={{ background: l.dash ? 'none' : l.color }}>
                {l.dash ? (
                  <svg width="32" height="4"><line x1="0" y1="2" x2="32" y2="2" stroke={l.color} strokeWidth="2" strokeDasharray="4 3" /></svg>
                ) : null}
              </div>
              <span className="text-xs text-white/60">{l.label}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 mt-2">
            <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center"><span className="text-white text-xs font-bold">O</span></div>
            <span className="text-xs text-white/60">Offense</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-red-600 flex items-center justify-center"><span className="text-white text-xs font-bold">X</span></div>
            <span className="text-xs text-white/60">Defense</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header() {
  const { mode } = useStore();
  const labels: Record<AppMode, string> = {
    coach: 'Coach Mode — Design & Edit Plays',
    '3d': '3D Viewer — Camera Preview & Animation',
    quiz: 'Quiz Mode — Test Your Basketball IQ',
  };
  return (
    <header className="h-12 bg-panel border-b border-white/10 flex items-center px-4 gap-4 shrink-0">
      <div className="text-white/50 text-sm">{labels[mode]}</div>
      <div className="ml-auto flex items-center gap-2 text-xs text-white/30">
        <span>Click player to select</span>
        <span>·</span>
        <span>Drag to move</span>
        <span>·</span>
        <span>Click canvas to draw path</span>
        <span>·</span>
        <span>Double-click to finish path</span>
        <span>·</span>
        <span>Right-click to cancel</span>
      </div>
    </header>
  );
}

// ─── Main Court Area ──────────────────────────────────────────────────────────

function CourtArea() {
  const { mode, quizActive } = useStore();

  return (
    <main className="flex-1 flex flex-col gap-3 p-4 overflow-hidden min-w-0">
      <div className="flex-1 relative flex items-center justify-center bg-black/20 rounded-xl border border-white/10 overflow-hidden">
        {(mode === 'coach' || mode === 'quiz') && <CourtCanvas2D />}
        {mode === '3d' && <ThreeDView />}
        {quizActive && <QuizOverlay />}

        {/* Mode badge */}
        <div className={`absolute top-3 left-3 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
          mode === 'coach' ? 'bg-blue-600/80' : mode === '3d' ? 'bg-purple-600/80' : 'bg-orange-600/80'
        }`}>
          {mode === '3d' ? '3D' : mode}
        </div>
      </div>
      <PlaybackControls />
    </main>
  );
}

// ─── Root Page ────────────────────────────────────────────────────────────────

export default function Page() {
  return (
    <div className="flex flex-col h-screen bg-court">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar />
        <CourtArea />
        <RightSidebar />
      </div>
    </div>
  );
}
