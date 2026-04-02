'use client';

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
  forwardRef, useImperativeHandle, Suspense,
} from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Text as DreiText } from '@react-three/drei';
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type CourtType     = 'half' | 'full';
type PlayType      = 'Horns' | 'Floppy' | 'Spain PnR' | 'BLOB' | 'SLOB' | 'Transition' | 'Custom';
type ActionType    = 'cut' | 'screen' | 'dribble' | 'pass' | 'handoff' | 'pop' | 'roll' | 'flare';
type Tool          = 'select' | 'cut' | 'pass' | 'dribble' | 'screen' | 'handoff' | 'place-offense' | 'place-defense' | 'text' | 'eraser';
type SituationType = 'BLOB' | 'SLOB' | 'Halfcourt' | 'Transition' | 'Custom';
type FormationName = 'Blank' | 'Horns' | '5-Out' | '4-Out-1-In' | 'Box' | 'Stack' | '1-4 High';
type SelectionType = 'player' | 'action' | 'frame' | null;

interface Pos        { x: number; y: number; }
interface Player     { id: string; team: 'offense' | 'defense'; label: string; positions: Record<number, Pos>; notes?: string; }
interface PlayAction {
  id: string; type: ActionType; fromPlayerId: string; toPlayerId?: string;
  toPosition?: Pos; frameIndex: number; note?: string;
  controlPoint?: Pos; // normalized 0-1, for bezier curve bending
}
interface Frame      { index: number; durationMs: number; autoAdvance?: boolean; }
interface Annotation { id: string; text: string; x: number; y: number; frameIndex: number; }
interface Play {
  id: string; name: string; court: CourtType; type: PlayType; situation: SituationType;
  tags: string[]; notes: string; players: Player[]; frames: Frame[];
  actions: PlayAction[]; annotations: Annotation[]; createdAt: string; updatedAt: string;
}
interface Selection { type: SelectionType; id: string | null; }
interface CreatePlayOpts {
  court: CourtType; type: PlayType; situation: SituationType;
  formation: FormationName; name: string; tags: string[]; notes: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}
function exportPNG(canvas: HTMLCanvasElement, name: string) {
  const a = document.createElement('a'); a.href = canvas.toDataURL('image/png');
  a.download = `${name}.png`; a.click();
}

// ── Bezier helpers ────────────────────────────────────────────────────────────
function sampleQuadBezier(p0: Pos, p1: Pos, p2: Pos, t: number): Pos {
  const mt = 1 - t;
  return { x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x, y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y };
}
function bezierTangent(p0: Pos, p1: Pos, p2: Pos, t: number): Pos {
  return { x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x), y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y) };
}
function isNearCurve(px: number, py: number, p0: Pos, p1: Pos, p2: Pos, thresh: number): boolean {
  for (let i = 0; i <= 20; i++) {
    const pt = sampleQuadBezier(p0, p1, p2, i / 20);
    if (Math.hypot(px - pt.x, py - pt.y) < thresh) return true;
  }
  return false;
}
function defaultCP(fromPx: Pos, toPx: Pos): Pos {
  const mx = (fromPx.x + toPx.x) / 2, my = (fromPx.y + toPx.y) / 2;
  const dx = toPx.x - fromPx.x, dy = toPx.y - fromPx.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return { x: mx, y: my };
  return { x: mx - (dy / len) * 40, y: my + (dx / len) * 40 };
}

// ── Court drawing ─────────────────────────────────────────────────────────────
interface CB { x: number; y: number; width: number; height: number; }

function drawHalf(ctx: CanvasRenderingContext2D, b: CB, mini = false) {
  const { x, y, width: W, height: H } = b, lw = mini ? 1 : 2;
  const gr = ctx.createLinearGradient(x, y, x + W, y + H);
  gr.addColorStop(0, '#c49a5a'); gr.addColorStop(0.4, '#b8864e'); gr.addColorStop(1, '#b07a42');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.roundRect(x, y, W, H, mini ? 4 : 8); ctx.fill();
  if (!mini) {
    ctx.save(); ctx.globalAlpha = 0.07; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    for (let gx = x + 12; gx < x + W; gx += 18) { ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + H); ctx.stroke(); }
    ctx.restore();
  }
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.roundRect(x, y, W, H, mini ? 4 : 8); ctx.stroke();
  const pW = W * (16 / 50), pH = H * (19 / 47), pX = x + (W - pW) / 2;
  ctx.fillStyle = 'rgba(160,100,40,0.45)'; ctx.fillRect(pX, y, pW, pH); ctx.strokeRect(pX, y, pW, pH);
  const ftY = y + pH, fcR = W * (6 / 50), fcX = x + W / 2;
  ctx.beginPath(); ctx.moveTo(pX, ftY); ctx.lineTo(pX + pW, ftY); ctx.stroke();
  ctx.beginPath(); ctx.arc(fcX, ftY, fcR, 0, Math.PI, false); ctx.stroke();
  ctx.save(); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(fcX, ftY, fcR, Math.PI, Math.PI * 2, false); ctx.stroke(); ctx.restore();
  const bkX = x + W / 2, bkY = y + H * (5.25 / 47);
  ctx.beginPath(); ctx.arc(bkX, bkY, W * (4 / 50), 0, Math.PI, false); ctx.stroke();
  const tR = W * (23.75 / 50), cX = W * (3 / 50), cDx = cX - W / 2;
  const cDy = Math.sqrt(Math.max(0, (W * 22 / 50) ** 2 - cDx ** 2));
  const clY = Math.min(bkY + cDy, y + H * (14 / 47)), lcX = x + cX, rcX = x + W - cX;
  ctx.beginPath(); ctx.moveTo(lcX, y); ctx.lineTo(lcX, clY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(rcX, y); ctx.lineTo(rcX, clY); ctx.stroke();
  const la = Math.atan2(clY - bkY, lcX - bkX), ra = Math.atan2(clY - bkY, rcX - bkX);
  ctx.beginPath(); ctx.arc(bkX, bkY, tR, ra, la, false); ctx.stroke();
  const bbY = y + H * (1.2 / 47), bbHW = W * (3 / 50);
  ctx.lineWidth = mini ? 2 : 3; ctx.beginPath(); ctx.moveTo(bkX - bbHW, bbY); ctx.lineTo(bkX + bbHW, bbY); ctx.stroke();
  ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(bkX, bkY, W * (0.75 / 50), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawHalfLines(ctx: CanvasRenderingContext2D, b: CB, flipped: boolean, lw: number) {
  const { x, y, width: W, height: H } = b, blY = flipped ? y + H : y;
  const pW = W * (16 / 50), pH = H * (19 / 47), pX = x + (W - pW) / 2, pY = flipped ? blY - pH : blY;
  ctx.fillStyle = 'rgba(160,100,40,0.4)';
  ctx.fillRect(pX, Math.min(pY, pY + pH), pW, pH); ctx.strokeRect(pX, Math.min(pY, pY + pH), pW, pH);
  const ftY = flipped ? blY - pH : blY + pH, fcR = W * (6 / 50), fcX = x + W / 2;
  ctx.beginPath(); ctx.moveTo(pX, ftY); ctx.lineTo(pX + pW, ftY); ctx.stroke();
  ctx.beginPath(); ctx.arc(fcX, ftY, fcR, flipped ? Math.PI : 0, flipped ? 0 : Math.PI, !flipped); ctx.stroke();
  ctx.save(); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(fcX, ftY, fcR, flipped ? 0 : Math.PI, flipped ? Math.PI : Math.PI * 2, !flipped); ctx.stroke(); ctx.restore();
  const bkX = x + W / 2, bkY = flipped ? blY - H * (5.25 / 47) : blY + H * (5.25 / 47);
  ctx.beginPath(); ctx.arc(bkX, bkY, W * (4 / 50), flipped ? Math.PI : 0, flipped ? 0 : Math.PI, !flipped); ctx.stroke();
  const tR = W * (23.75 / 50), cX = W * (3 / 50), cDx = cX - W / 2;
  const cDy = Math.sqrt(Math.max(0, (W * 22 / 50) ** 2 - cDx ** 2));
  const cAbsY = flipped ? bkY - cDy : bkY + cDy;
  const clY = flipped ? Math.max(cAbsY, y + H * (33 / 47)) : Math.min(cAbsY, y + H * (14 / 47));
  const lcX = x + cX, rcX = x + W - cX;
  ctx.beginPath(); ctx.moveTo(lcX, blY); ctx.lineTo(lcX, clY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(rcX, blY); ctx.lineTo(rcX, clY); ctx.stroke();
  const la = Math.atan2(clY - bkY, lcX - bkX), ra = Math.atan2(clY - bkY, rcX - bkX);
  ctx.beginPath(); if (flipped) ctx.arc(bkX, bkY, tR, la, ra, false); else ctx.arc(bkX, bkY, tR, ra, la, false); ctx.stroke();
  const bbY = flipped ? blY - H * (1.2 / 47) : blY + H * (1.2 / 47), bbHW = W * (3 / 50);
  ctx.lineWidth = lw + 1; ctx.beginPath(); ctx.moveTo(bkX - bbHW, bbY); ctx.lineTo(bkX + bbHW, bbY); ctx.stroke();
  ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(bkX, bkY, W * (0.75 / 50), 0, Math.PI * 2); ctx.stroke();
}

function drawFull(ctx: CanvasRenderingContext2D, b: CB, mini = false) {
  const { x, y, width: W, height: H } = b, halfH = H / 2, lw = mini ? 1 : 2;
  const gr = ctx.createLinearGradient(x, y, x, y + H);
  gr.addColorStop(0, '#c49a5a'); gr.addColorStop(0.5, '#b8864e'); gr.addColorStop(1, '#c49a5a');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.roundRect(x, y, W, H, mini ? 4 : 8); ctx.fill();
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.roundRect(x, y, W, H, mini ? 4 : 8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y + halfH); ctx.lineTo(x + W, y + halfH); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + W / 2, y + halfH, W * (6 / 50), 0, Math.PI * 2); ctx.stroke();
  drawHalfLines(ctx, { x, y, width: W, height: halfH }, false, lw);
  drawHalfLines(ctx, { x, y: y + halfH, width: W, height: halfH }, true, lw);
  ctx.restore();
}

function arrowHead(ctx: CanvasRenderingContext2D, from: Pos, to: Pos) {
  const dx = to.x - from.x, dy = to.y - from.y, a = Math.atan2(dy, dx), l = 12, aa = 0.45;
  ctx.beginPath(); ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - l * Math.cos(a - aa), to.y - l * Math.sin(a - aa));
  ctx.lineTo(to.x - l * Math.cos(a + aa), to.y - l * Math.sin(a + aa));
  ctx.closePath(); ctx.fill();
}

// cp = control point in pixel space (optional, for bezier curves)
function drawArrow(ctx: CanvasRenderingContext2D, from: Pos, to: Pos, type: string, color: string, sel: boolean, cp?: Pos) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
  if (len < 2) return;
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.globalAlpha = sel ? 1 : 0.85; ctx.lineWidth = sel ? 3 : 2;

  if (type === 'screen') {
    // Screen always straight, perpendicular bar
    ctx.setLineDash([]);
    const sf = 0.85, sp = { x: from.x + dx * sf, y: from.y + dy * sf }, pl = 18;
    const ux = dx / len, uy = dy / len;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
    ctx.lineWidth = sel ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(sp.x - uy * pl, sp.y + ux * pl); ctx.lineTo(sp.x + uy * pl, sp.y - ux * pl); ctx.stroke();
    ctx.restore(); return;
  }

  if (type === 'dribble') {
    ctx.setLineDash([]);
    if (cp) {
      // Curved dribble: sample bezier, draw zigzag along curve
      const steps = Math.max(16, Math.floor(len / 12));
      ctx.beginPath(); ctx.moveTo(from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const pt = sampleQuadBezier(from, cp, to, t);
        const tang = bezierTangent(from, cp, to, t);
        const tl = Math.hypot(tang.x, tang.y);
        if (tl < 0.01) continue;
        const ux = tang.x / tl, uy = tang.y / tl;
        const side = i % 2 === 0 ? 1 : -1;
        ctx.lineTo(pt.x + (-uy) * 6 * side, pt.y + ux * 6 * side);
      }
      ctx.lineTo(to.x, to.y); ctx.stroke();
      const tang = bezierTangent(from, cp, to, 1);
      const tl = Math.hypot(tang.x, tang.y);
      const preTo = tl > 0 ? { x: to.x - tang.x / tl * 8, y: to.y - tang.y / tl * 8 } : from;
      arrowHead(ctx, preTo, to);
    } else {
      const ux = dx / len, uy = dy / len, amp = 6, freq = 18, steps = Math.floor(len / freq) * 2;
      ctx.beginPath(); ctx.moveTo(from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, s = i % 2 === 0 ? 1 : -1;
        ctx.lineTo(from.x + dx * t + (-uy) * amp * s, from.y + dy * t + ux * amp * s);
      }
      ctx.lineTo(to.x, to.y); ctx.stroke();
      arrowHead(ctx, from, to);
    }
    ctx.restore(); return;
  }

  if (type === 'pass') ctx.setLineDash([8, 5]); else ctx.setLineDash([]);

  if (cp) {
    // Quadratic bezier curve
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(cp.x, cp.y, to.x, to.y); ctx.stroke();
    ctx.setLineDash([]);
    // Arrowhead in direction of tangent at endpoint
    const tang = bezierTangent(from, cp, to, 1);
    const tl = Math.hypot(tang.x, tang.y);
    const preTo = tl > 0 ? { x: to.x - tang.x / tl * 8, y: to.y - tang.y / tl * 8 } : from;
    arrowHead(ctx, preTo, to);
  } else {
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.setLineDash([]);
    arrowHead(ctx, from, to);
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA — FORMATIONS
// ─────────────────────────────────────────────────────────────────────────────

interface FP { label: string; team: 'offense' | 'defense'; x: number; y: number; }
const FORMATIONS: Record<FormationName, FP[]> = {
  Blank: [],
  Horns: [
    { label: 'PG', team: 'offense', x: 0.50, y: 0.52 }, { label: 'SG', team: 'offense', x: 0.78, y: 0.46 },
    { label: 'SF', team: 'offense', x: 0.22, y: 0.46 }, { label: 'PF', team: 'offense', x: 0.65, y: 0.30 },
    { label: 'C',  team: 'offense', x: 0.35, y: 0.30 },
  ],
  '5-Out': [
    { label: 'PG', team: 'offense', x: 0.50, y: 0.58 }, { label: 'SG', team: 'offense', x: 0.82, y: 0.44 },
    { label: 'SF', team: 'offense', x: 0.82, y: 0.72 }, { label: 'PF', team: 'offense', x: 0.18, y: 0.72 },
    { label: 'C',  team: 'offense', x: 0.18, y: 0.44 },
  ],
  '4-Out-1-In': [
    { label: 'PG', team: 'offense', x: 0.50, y: 0.58 }, { label: 'SG', team: 'offense', x: 0.80, y: 0.44 },
    { label: 'SF', team: 'offense', x: 0.80, y: 0.72 }, { label: 'PF', team: 'offense', x: 0.20, y: 0.72 },
    { label: 'C',  team: 'offense', x: 0.50, y: 0.18 },
  ],
  Box: [
    { label: 'PG', team: 'offense', x: 0.50, y: 0.58 }, { label: 'SG', team: 'offense', x: 0.65, y: 0.25 },
    { label: 'SF', team: 'offense', x: 0.35, y: 0.25 }, { label: 'PF', team: 'offense', x: 0.65, y: 0.40 },
    { label: 'C',  team: 'offense', x: 0.35, y: 0.40 },
  ],
  Stack: [
    { label: 'PG', team: 'offense', x: 0.50, y: 0.60 }, { label: 'SG', team: 'offense', x: 0.62, y: 0.30 },
    { label: 'SF', team: 'offense', x: 0.50, y: 0.38 }, { label: 'PF', team: 'offense', x: 0.62, y: 0.46 },
    { label: 'C',  team: 'offense', x: 0.50, y: 0.54 },
  ],
  '1-4 High': [
    { label: 'PG', team: 'offense', x: 0.50, y: 0.58 }, { label: 'SG', team: 'offense', x: 0.76, y: 0.36 },
    { label: 'SF', team: 'offense', x: 0.60, y: 0.36 }, { label: 'PF', team: 'offense', x: 0.40, y: 0.36 },
    { label: 'C',  team: 'offense', x: 0.24, y: 0.36 },
  ],
};
const FORMATION_NAMES: FormationName[] = ['Blank', 'Horns', '5-Out', '4-Out-1-In', 'Box', 'Stack', '1-4 High'];

// ─────────────────────────────────────────────────────────────────────────────
// DATA — PRESET PLAYS
// ─────────────────────────────────────────────────────────────────────────────

function mkPlay(id: string, name: string, court: CourtType, type: PlayType, situation: SituationType,
  tags: string[], notes: string, players: Player[], actions: PlayAction[]): Play {
  const d = '2024-01-01T00:00:00.000Z';
  return { id, name, court, type, situation, tags, notes, players, actions, annotations: [],
    frames: [{ index: 0, durationMs: 1500 }, { index: 1, durationMs: 1500 }], createdAt: d, updatedAt: d };
}

const PRESET_PLAYS: Play[] = [
  mkPlay('preset-horns', 'Horns PnR', 'half', 'Horns', 'Halfcourt', ['PnR', 'Horns'],
    'PG attacks pick-and-roll with the big at the elbow.',
    [
      { id: 'p1', team: 'offense', label: 'PG', positions: { 0: { x: 0.50, y: 0.52 }, 1: { x: 0.44, y: 0.38 } } },
      { id: 'p2', team: 'offense', label: 'SG', positions: { 0: { x: 0.78, y: 0.46 }, 1: { x: 0.82, y: 0.68 } } },
      { id: 'p3', team: 'offense', label: 'SF', positions: { 0: { x: 0.22, y: 0.46 }, 1: { x: 0.18, y: 0.68 } } },
      { id: 'p4', team: 'offense', label: 'PF', positions: { 0: { x: 0.65, y: 0.30 }, 1: { x: 0.58, y: 0.42 } } },
      { id: 'p5', team: 'offense', label: 'C',  positions: { 0: { x: 0.35, y: 0.30 }, 1: { x: 0.35, y: 0.30 } } },
    ],
    [
      { id: 'a1', type: 'dribble', fromPlayerId: 'p1', toPosition: { x: 0.44, y: 0.38 }, frameIndex: 0 },
      { id: 'a2', type: 'screen', fromPlayerId: 'p4', toPlayerId: 'p1', frameIndex: 0 },
      { id: 'a3', type: 'cut', fromPlayerId: 'p2', toPosition: { x: 0.82, y: 0.68 }, frameIndex: 0 },
      { id: 'a4', type: 'roll', fromPlayerId: 'p4', toPosition: { x: 0.58, y: 0.42 }, frameIndex: 1 },
    ],
  ),
  mkPlay('preset-floppy', 'Floppy', 'half', 'Floppy', 'Halfcourt', ['Curl', 'Flare'],
    'Two players read the defense off down screens.',
    [
      { id: 'f1', team: 'offense', label: 'PG', positions: { 0: { x: 0.50, y: 0.62 }, 1: { x: 0.50, y: 0.62 } } },
      { id: 'f2', team: 'offense', label: 'SG', positions: { 0: { x: 0.30, y: 0.10 }, 1: { x: 0.72, y: 0.42 } } },
      { id: 'f3', team: 'offense', label: 'SF', positions: { 0: { x: 0.70, y: 0.10 }, 1: { x: 0.20, y: 0.60 } } },
      { id: 'f4', team: 'offense', label: 'PF', positions: { 0: { x: 0.35, y: 0.30 }, 1: { x: 0.35, y: 0.30 } } },
      { id: 'f5', team: 'offense', label: 'C',  positions: { 0: { x: 0.65, y: 0.30 }, 1: { x: 0.65, y: 0.30 } } },
    ],
    [
      { id: 'fa1', type: 'screen', fromPlayerId: 'f4', toPlayerId: 'f2', frameIndex: 0 },
      { id: 'fa2', type: 'screen', fromPlayerId: 'f5', toPlayerId: 'f3', frameIndex: 0 },
      { id: 'fa3', type: 'cut', fromPlayerId: 'f2', toPosition: { x: 0.72, y: 0.42 }, frameIndex: 0 },
      { id: 'fa4', type: 'flare', fromPlayerId: 'f3', toPosition: { x: 0.20, y: 0.60 }, frameIndex: 0 },
      { id: 'fa5', type: 'pass', fromPlayerId: 'f1', toPlayerId: 'f2', frameIndex: 1 },
    ],
  ),
  mkPlay('preset-spain', 'Spain PnR', 'half', 'Spain PnR', 'Halfcourt', ['Spain', 'PnR'],
    'PnR while a second big back-screens the roller\'s defender.',
    [
      { id: 's1', team: 'offense', label: 'PG', positions: { 0: { x: 0.50, y: 0.55 }, 1: { x: 0.40, y: 0.40 } } },
      { id: 's2', team: 'offense', label: 'SG', positions: { 0: { x: 0.78, y: 0.50 }, 1: { x: 0.78, y: 0.50 } } },
      { id: 's3', team: 'offense', label: 'SF', positions: { 0: { x: 0.22, y: 0.50 }, 1: { x: 0.22, y: 0.50 } } },
      { id: 's4', team: 'offense', label: 'PF', positions: { 0: { x: 0.62, y: 0.32 }, 1: { x: 0.50, y: 0.22 } } },
      { id: 's5', team: 'offense', label: 'C',  positions: { 0: { x: 0.38, y: 0.32 }, 1: { x: 0.38, y: 0.32 } } },
    ],
    [
      { id: 'sa1', type: 'screen', fromPlayerId: 's4', toPlayerId: 's1', frameIndex: 0 },
      { id: 'sa2', type: 'dribble', fromPlayerId: 's1', toPosition: { x: 0.40, y: 0.40 }, frameIndex: 0 },
      { id: 'sa3', type: 'screen', fromPlayerId: 's5', toPlayerId: 's4', frameIndex: 0 },
      { id: 'sa4', type: 'roll', fromPlayerId: 's4', toPosition: { x: 0.50, y: 0.22 }, frameIndex: 1 },
      { id: 'sa5', type: 'pass', fromPlayerId: 's1', toPlayerId: 's4', frameIndex: 1 },
    ],
  ),
  mkPlay('preset-blob', 'BLOB Box', 'half', 'BLOB', 'BLOB', ['BLOB', 'Box'],
    'Box formation BLOB — guards curl off down screens.',
    [
      { id: 'b1', team: 'offense', label: '1', positions: { 0: { x: 0.50, y: 0.02 }, 1: { x: 0.50, y: 0.02 } } },
      { id: 'b2', team: 'offense', label: '2', positions: { 0: { x: 0.63, y: 0.22 }, 1: { x: 0.78, y: 0.42 } } },
      { id: 'b3', team: 'offense', label: '3', positions: { 0: { x: 0.37, y: 0.22 }, 1: { x: 0.22, y: 0.42 } } },
      { id: 'b4', team: 'offense', label: '4', positions: { 0: { x: 0.63, y: 0.38 }, 1: { x: 0.63, y: 0.22 } } },
      { id: 'b5', team: 'offense', label: '5', positions: { 0: { x: 0.37, y: 0.38 }, 1: { x: 0.37, y: 0.22 } } },
    ],
    [
      { id: 'ba1', type: 'screen', fromPlayerId: 'b4', toPlayerId: 'b2', frameIndex: 0 },
      { id: 'ba2', type: 'screen', fromPlayerId: 'b5', toPlayerId: 'b3', frameIndex: 0 },
      { id: 'ba3', type: 'cut', fromPlayerId: 'b2', toPosition: { x: 0.78, y: 0.42 }, frameIndex: 0 },
      { id: 'ba4', type: 'cut', fromPlayerId: 'b3', toPosition: { x: 0.22, y: 0.42 }, frameIndex: 0 },
      { id: 'ba5', type: 'pass', fromPlayerId: 'b1', toPlayerId: 'b2', frameIndex: 1 },
    ],
  ),
  mkPlay('preset-slob', 'SLOB Quick Hitter', 'half', 'SLOB', 'SLOB', ['SLOB', 'Sideline'],
    'Stack SLOB — shooter curls to the elbow.',
    [
      { id: 'sl1', team: 'offense', label: '1', positions: { 0: { x: 0.02, y: 0.40 }, 1: { x: 0.02, y: 0.40 } } },
      { id: 'sl2', team: 'offense', label: '2', positions: { 0: { x: 0.25, y: 0.40 }, 1: { x: 0.55, y: 0.32 } } },
      { id: 'sl3', team: 'offense', label: '3', positions: { 0: { x: 0.35, y: 0.40 }, 1: { x: 0.35, y: 0.55 } } },
      { id: 'sl4', team: 'offense', label: '4', positions: { 0: { x: 0.45, y: 0.40 }, 1: { x: 0.25, y: 0.40 } } },
      { id: 'sl5', team: 'offense', label: '5', positions: { 0: { x: 0.55, y: 0.40 }, 1: { x: 0.72, y: 0.48 } } },
    ],
    [
      { id: 'sla1', type: 'screen', fromPlayerId: 'sl4', toPlayerId: 'sl2', frameIndex: 0 },
      { id: 'sla2', type: 'cut', fromPlayerId: 'sl2', toPosition: { x: 0.55, y: 0.32 }, frameIndex: 0 },
      { id: 'sla3', type: 'cut', fromPlayerId: 'sl3', toPosition: { x: 0.35, y: 0.55 }, frameIndex: 0 },
      { id: 'sla4', type: 'pass', fromPlayerId: 'sl1', toPlayerId: 'sl2', frameIndex: 1 },
    ],
  ),
  mkPlay('preset-transition', 'Early Offense', 'full', 'Transition', 'Transition', ['Transition', 'Fast Break'],
    'Secondary break — PG pushes, wings fill lanes, bigs trail.',
    [
      { id: 't1', team: 'offense', label: 'PG', positions: { 0: { x: 0.50, y: 0.80 }, 1: { x: 0.50, y: 0.52 } } },
      { id: 't2', team: 'offense', label: 'SG', positions: { 0: { x: 0.80, y: 0.88 }, 1: { x: 0.80, y: 0.50 } } },
      { id: 't3', team: 'offense', label: 'SF', positions: { 0: { x: 0.20, y: 0.88 }, 1: { x: 0.20, y: 0.50 } } },
      { id: 't4', team: 'offense', label: 'PF', positions: { 0: { x: 0.60, y: 0.92 }, 1: { x: 0.55, y: 0.30 } } },
      { id: 't5', team: 'offense', label: 'C',  positions: { 0: { x: 0.40, y: 0.92 }, 1: { x: 0.45, y: 0.22 } } },
    ],
    [
      { id: 'ta1', type: 'dribble', fromPlayerId: 't1', toPosition: { x: 0.50, y: 0.52 }, frameIndex: 0 },
      { id: 'ta2', type: 'cut', fromPlayerId: 't2', toPosition: { x: 0.80, y: 0.50 }, frameIndex: 0 },
      { id: 'ta3', type: 'cut', fromPlayerId: 't3', toPosition: { x: 0.20, y: 0.50 }, frameIndex: 0 },
      { id: 'ta4', type: 'pass', fromPlayerId: 't1', toPlayerId: 't2', frameIndex: 1 },
    ],
  ),
];

// ─────────────────────────────────────────────────────────────────────────────
// STORE
// ─────────────────────────────────────────────────────────────────────────────

function clonePlay(p: Play): Play { return JSON.parse(JSON.stringify(p)); }
function touchPlay(p: Play): Play { return { ...p, updatedAt: new Date().toISOString() }; }
function mutatePlays(plays: Play[], id: string, fn: (p: Play) => Play): Play[] {
  return plays.map(p => p.id === id ? touchPlay(fn(p)) : p);
}
function pushHist(stack: Play[][], plays: Play[]): Play[][] {
  return [...stack, plays.map(clonePlay)].slice(-30);
}

interface St {
  plays: Play[]; view: 'library' | 'editor'; activePlayId: string | null;
  currentFrame: number; selection: Selection; activeTool: Tool;
  savedStatus: 'saved' | 'unsaved'; isAnimating: boolean; animFrame: number;
  searchQuery: string; filterSituation: string | null; sortBy: 'recent' | 'az' | 'type';
  undoStack: Play[][]; redoStack: Play[][]; quizPlayId: string | null; show3D: boolean;
  setView(v: 'library' | 'editor'): void; openPlay(id: string): void; backToLibrary(): void;
  createPlay(o: CreatePlayOpts): string; duplicatePlay(id: string): void; deletePlay(id: string): void;
  updatePlayMeta(id: string, u: Partial<Pick<Play, 'name' | 'tags' | 'notes' | 'type' | 'situation' | 'court'>>): void;
  setActiveTool(t: Tool): void; setCurrentFrame(f: number): void; setSelection(s: Selection): void;
  addPlayer(pid: string, p: Omit<Player, 'id'>): void;
  updatePlayer(pid: string, plid: string, u: Partial<Omit<Player, 'id'>>): void;
  movePlayer(pid: string, plid: string, fi: number, pos: Pos): void;
  deletePlayer(pid: string, plid: string): void;
  addAction(pid: string, a: Omit<PlayAction, 'id'>): void;
  updateAction(pid: string, aid: string, u: Partial<Omit<PlayAction, 'id'>>): void;
  deleteAction(pid: string, aid: string): void;
  addFrame(pid: string): void; duplicateFrame(pid: string, fi: number): void;
  deleteFrame(pid: string, fi: number): void; updateFrame(pid: string, fi: number, u: Partial<Frame>): void;
  addAnnotation(pid: string, a: Omit<Annotation, 'id'>): void;
  undo(): void; redo(): void;
  setSearchQuery(q: string): void; setFilterSituation(s: string | null): void; setSortBy(s: 'recent' | 'az' | 'type'): void;
  setIsAnimating(v: boolean): void; setAnimFrame(f: number): void;
  openQuiz(id: string): void; closeQuiz(): void; setShow3D(v: boolean): void;
}

const useStore = create<St>()(persist((set, get) => ({
  plays: PRESET_PLAYS.map(clonePlay), view: 'library', activePlayId: null,
  currentFrame: 0, selection: { type: null, id: null }, activeTool: 'select',
  savedStatus: 'saved', isAnimating: false, animFrame: 0,
  searchQuery: '', filterSituation: null, sortBy: 'recent',
  undoStack: [], redoStack: [], quizPlayId: null, show3D: false,

  setView: v => set({ view: v }),
  openPlay: id => set({ view: 'editor', activePlayId: id, currentFrame: 0, selection: { type: null, id: null }, activeTool: 'select', undoStack: [], redoStack: [] }),
  backToLibrary: () => set({ view: 'library', activePlayId: null, isAnimating: false, show3D: false }),

  createPlay: opts => {
    const id = nanoid(), fp = FORMATIONS[opts.formation] ?? [], now = new Date().toISOString();
    const players: Player[] = fp.map(f => ({ id: nanoid(), team: f.team, label: f.label, positions: { 0: { x: f.x, y: f.y } } }));
    const play: Play = { id, name: opts.name || 'Untitled Play', court: opts.court, type: opts.type, situation: opts.situation, tags: opts.tags, notes: opts.notes, players, frames: [{ index: 0, durationMs: 1500 }], actions: [], annotations: [], createdAt: now, updatedAt: now };
    set(s => ({ plays: [play, ...s.plays], view: 'editor', activePlayId: id, currentFrame: 0, selection: { type: null, id: null }, activeTool: 'select', undoStack: [], redoStack: [] }));
    return id;
  },
  duplicatePlay: id => {
    const src = get().plays.find(p => p.id === id); if (!src) return;
    const now = new Date().toISOString();
    set(s => ({ plays: [{ ...clonePlay(src), id: nanoid(), name: `${src.name} (copy)`, createdAt: now, updatedAt: now }, ...s.plays] }));
  },
  deletePlay: id => set(s => ({ plays: s.plays.filter(p => p.id !== id), activePlayId: s.activePlayId === id ? null : s.activePlayId, view: s.activePlayId === id ? 'library' : s.view })),
  updatePlayMeta: (id, u) => set(s => ({ plays: mutatePlays(s.plays, id, p => ({ ...p, ...u })), savedStatus: 'unsaved' })),
  setActiveTool: t => set({ activeTool: t }),
  setCurrentFrame: f => set({ currentFrame: f, selection: { type: null, id: null } }),
  setSelection: s => set({ selection: s }),
  addPlayer: (pid, pd) => set(s => { const prev = s.plays, pl = { id: nanoid(), ...pd }; return { plays: mutatePlays(prev, pid, p => ({ ...p, players: [...p.players, pl] })), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved' }; }),
  updatePlayer: (pid, plid, u) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, players: p.players.map(pl => pl.id === plid ? { ...pl, ...u } : pl) })), savedStatus: 'unsaved' })),
  movePlayer: (pid, plid, fi, pos) => set(s => { const prev = s.plays; return { plays: mutatePlays(prev, pid, p => ({ ...p, players: p.players.map(pl => pl.id === plid ? { ...pl, positions: { ...pl.positions, [fi]: pos } } : pl) })), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved' }; }),
  deletePlayer: (pid, plid) => set(s => { const prev = s.plays; return { plays: mutatePlays(prev, pid, p => ({ ...p, players: p.players.filter(pl => pl.id !== plid), actions: p.actions.filter(a => a.fromPlayerId !== plid && a.toPlayerId !== plid) })), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved', selection: { type: null, id: null } }; }),
  addAction: (pid, ad) => set(s => { const prev = s.plays, na = { id: nanoid(), ...ad }; return { plays: mutatePlays(prev, pid, p => ({ ...p, actions: [...p.actions, na] })), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved' }; }),
  updateAction: (pid, aid, u) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, actions: p.actions.map(a => a.id === aid ? { ...a, ...u } : a) })), savedStatus: 'unsaved' })),
  deleteAction: (pid, aid) => set(s => { const prev = s.plays; return { plays: mutatePlays(prev, pid, p => ({ ...p, actions: p.actions.filter(a => a.id !== aid) })), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved', selection: { type: null, id: null } }; }),
  addFrame: pid => set(s => { const prev = s.plays; return { plays: mutatePlays(prev, pid, p => { const ni = p.frames.length, li = ni - 1; return { ...p, frames: [...p.frames, { index: ni, durationMs: 1500 }], players: p.players.map(pl => ({ ...pl, positions: { ...pl.positions, [ni]: pl.positions[li] ?? pl.positions[0] ?? { x: 0.5, y: 0.5 } } })) }; }), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved' }; }),
  duplicateFrame: (pid, fi) => set(s => { const prev = s.plays; return { plays: mutatePlays(prev, pid, p => { const ni = p.frames.length; return { ...p, frames: [...p.frames, { index: ni, durationMs: 1500 }], players: p.players.map(pl => ({ ...pl, positions: { ...pl.positions, [ni]: { ...(pl.positions[fi] ?? { x: 0.5, y: 0.5 }) } } })), actions: [...p.actions, ...p.actions.filter(a => a.frameIndex === fi).map(a => ({ ...a, id: nanoid(), frameIndex: ni }))] }; }), undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved' }; }),
  deleteFrame: (pid, fi) => set(s => {
    const prev = s.plays;
    const plays = mutatePlays(prev, pid, p => {
      if (p.frames.length <= 1) return p;
      const frames = p.frames.filter(f => f.index !== fi).map((f, i) => ({ ...f, index: i }));
      const actions = p.actions.filter(a => a.frameIndex !== fi).map(a => ({ ...a, frameIndex: a.frameIndex > fi ? a.frameIndex - 1 : a.frameIndex }));
      const players = p.players.map(pl => { const np: Record<number, Pos> = {}; Object.entries(pl.positions).forEach(([k, v]) => { const ki = +k; if (ki !== fi) np[ki > fi ? ki - 1 : ki] = v; }); return { ...pl, positions: np }; });
      return { ...p, frames, actions, players };
    });
    const nf = Math.min(s.currentFrame, plays.find(p => p.id === pid)!.frames.length - 1);
    return { plays, currentFrame: nf, undoStack: pushHist(s.undoStack, prev), redoStack: [], savedStatus: 'unsaved' };
  }),
  updateFrame: (pid, fi, u) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, frames: p.frames.map(f => f.index === fi ? { ...f, ...u } : f) })), savedStatus: 'unsaved' })),
  addAnnotation: (pid, ad) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, annotations: [...(p.annotations ?? []), { id: nanoid(), ...ad }] })), savedStatus: 'unsaved' })),
  undo: () => set(s => { if (!s.undoStack.length) return s; const prev = s.plays.map(clonePlay), stack = [...s.undoStack], r = stack.pop()!; return { plays: r, undoStack: stack, redoStack: [...s.redoStack, prev], savedStatus: 'unsaved' }; }),
  redo: () => set(s => { if (!s.redoStack.length) return s; const prev = s.plays.map(clonePlay), stack = [...s.redoStack], r = stack.pop()!; return { plays: r, undoStack: [...s.undoStack, prev], redoStack: stack, savedStatus: 'unsaved' }; }),
  setSearchQuery: q => set({ searchQuery: q }),
  setFilterSituation: s => set({ filterSituation: s }),
  setSortBy: s => set({ sortBy: s }),
  setIsAnimating: v => set({ isAnimating: v }),
  setAnimFrame: f => set({ animFrame: f }),
  openQuiz: id => set({ quizPlayId: id }),
  closeQuiz: () => set({ quizPlayId: null }),
  setShow3D: v => set({ show3D: v }),
}), { name: 'cvpro-v2', partialize: s => ({ plays: s.plays, sortBy: s.sortBy }) }));

let _st: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe(s => {
  if (s.savedStatus === 'unsaved') {
    if (_st) clearTimeout(_st);
    _st = setTimeout(() => useStore.setState({ savedStatus: 'saved' }), 1500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const SIT_CLS: Record<string, string> = {
  Halfcourt: 'bg-blue-900/60 text-blue-300', BLOB: 'bg-purple-900/60 text-purple-300',
  SLOB: 'bg-indigo-900/60 text-indigo-300', Transition: 'bg-green-900/60 text-green-300',
  Custom: 'bg-slate-700 text-slate-300',
};

function MiniPreview({ play }: { play: Play }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const W = canvas.width, H = canvas.height, P = 4, b = { x: P, y: P, width: W - P * 2, height: H - P * 2 };
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, W, H);
    play.court === 'full' ? drawFull(ctx, b, true) : drawHalf(ctx, b, true);
    play.players.forEach(pl => {
      const pos = pl.positions[0]; if (!pos) return;
      const px = b.x + pos.x * b.width, py = b.y + pos.y * b.height;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = pl.team === 'offense' ? '#3b82f6' : '#ef4444'; ctx.fill();
      ctx.font = '5px system-ui'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pl.label.charAt(0), px, py);
    });
    play.actions.filter(a => a.frameIndex === 0).forEach(a => {
      const fp = play.players.find(p => p.id === a.fromPlayerId); if (!fp) return;
      const f0 = fp.positions[0]; if (!f0) return;
      let t0 = a.toPosition; if (!t0 && a.toPlayerId) t0 = play.players.find(p => p.id === a.toPlayerId)?.positions[0];
      if (!t0) return;
      const fromPx = { x: b.x + f0.x * b.width, y: b.y + f0.y * b.height };
      const toPx = { x: b.x + t0.x * b.width, y: b.y + t0.y * b.height };
      drawArrow(ctx, fromPx, toPx, a.type, '#f97316', false);
    });
  }, [play]);
  return <canvas ref={ref} width={200} height={play.court === 'full' ? 188 : 94} className="w-full rounded-lg" />;
}

function PlayCard({ play, onOpen }: { play: Play; onOpen(): void }) {
  const { duplicatePlay, deletePlay, openQuiz } = useStore();
  const sc = SIT_CLS[play.situation] ?? SIT_CLS.Custom;
  const upd = new Date(play.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="group bg-slate-800 border border-slate-700 rounded-xl overflow-hidden hover:border-orange-500/50 hover:shadow-lg hover:shadow-orange-900/20 transition-all duration-200 cursor-pointer" onClick={onOpen}>
      <div className="bg-slate-900 p-2"><MiniPreview play={play} /></div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-semibold text-white text-sm leading-tight group-hover:text-orange-400 transition-colors line-clamp-2">{play.name}</h3>
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            <button className="text-slate-400 hover:text-white text-xs px-1 py-0.5 rounded hover:bg-slate-700" onClick={() => duplicatePlay(play.id)}>⧉</button>
            <button className="text-slate-400 hover:text-orange-400 text-xs px-1 py-0.5 rounded hover:bg-slate-700" onClick={() => openQuiz(play.id)}>?</button>
            <button className="text-slate-400 hover:text-red-400 text-xs px-1 py-0.5 rounded hover:bg-slate-700" onClick={() => { if (confirm('Delete?')) deletePlay(play.id); }}>✕</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 mb-2">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${sc}`}>{play.situation}</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-300">{play.court === 'half' ? '½ Court' : 'Full Court'}</span>
          {play.tags.slice(0, 2).map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700/50 text-slate-400">{t}</span>)}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500">{upd}</span>
          <span className="text-[10px] text-slate-500">{play.frames.length}f · {play.players.filter(p => p.team === 'offense').length}v{play.players.filter(p => p.team === 'defense').length}</span>
        </div>
      </div>
    </div>
  );
}

function NewPlayModal({ onClose, onCreate }: { onClose(): void; onCreate(o: CreatePlayOpts): void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [court, setCourt] = useState<CourtType>('half');
  const [sit, setSit] = useState<SituationType>('Halfcourt');
  const [form, setForm] = useState<FormationName>('Horns');
  const [name, setName] = useState('');
  const [type, setType] = useState<PlayType>('Custom');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const btn = (a: boolean, ex = '') => `px-3 py-2 rounded-xl border text-sm font-medium transition-all ${a ? 'border-orange-500 bg-orange-500/10 text-orange-400' : 'border-slate-600 bg-slate-700/50 text-slate-300 hover:border-slate-500 hover:text-white'} ${ex}`;
  const inp = "w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-orange-500";
  const COURTS = [{ v: 'half' as CourtType, l: 'Half Court', d: 'Set plays, BLOBs, SLOBs' }, { v: 'full' as CourtType, l: 'Full Court', d: 'Transition, press breaks' }];
  const SITS: { v: SituationType; l: string }[] = [{ v: 'Halfcourt', l: 'Halfcourt' }, { v: 'BLOB', l: 'BLOB' }, { v: 'SLOB', l: 'SLOB' }, { v: 'Transition', l: 'Transition' }, { v: 'Custom', l: 'Custom' }];
  const TYPES: { v: PlayType; l: string }[] = [{ v: 'Custom', l: 'Custom' }, { v: 'Horns', l: 'Horns' }, { v: 'Floppy', l: 'Floppy' }, { v: 'Spain PnR', l: 'Spain PnR' }, { v: 'BLOB', l: 'BLOB' }, { v: 'SLOB', l: 'SLOB' }, { v: 'Transition', l: 'Transition' }];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div><h2 className="text-white font-bold text-lg">New Play</h2><p className="text-slate-400 text-sm">Step {step} of 3</p></div>
          <button onClick={onClose} className="text-slate-400 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-700">✕</button>
        </div>
        <div className="flex gap-1 px-6 mb-5">{[1, 2, 3].map(s => <div key={s} className={`h-1 rounded-full flex-1 transition-all ${s <= step ? 'bg-orange-500' : 'bg-slate-600'}`} />)}</div>
        <div className="px-6 pb-6">
          {step === 1 && <div className="space-y-4">
            <div><label className="text-slate-300 text-sm font-medium mb-2 block">Court Type</label><div className="grid grid-cols-2 gap-2">{COURTS.map(o => <button key={o.v} onClick={() => setCourt(o.v)} className={btn(court === o.v, 'text-left p-3')}><div className="font-medium">{o.l}</div><div className="text-xs text-slate-400 mt-0.5">{o.d}</div></button>)}</div></div>
            <div><label className="text-slate-300 text-sm font-medium mb-2 block">Situation</label><div className="grid grid-cols-3 gap-2">{SITS.map(o => <button key={o.v} onClick={() => setSit(o.v)} className={btn(sit === o.v)}>{o.l}</button>)}</div></div>
          </div>}
          {step === 2 && <div><label className="text-slate-300 text-sm font-medium mb-2 block">Formation</label><div className="grid grid-cols-2 gap-2">{FORMATION_NAMES.map(f => <button key={f} onClick={() => setForm(f)} className={btn(form === f, 'py-3 px-4')}>{f}</button>)}</div></div>}
          {step === 3 && <div className="space-y-4">
            <div><label className="text-slate-300 text-sm font-medium mb-1.5 block">Name</label><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Horns PnR Option" autoFocus className={inp} /></div>
            <div><label className="text-slate-300 text-sm font-medium mb-1.5 block">Type</label><select value={type} onChange={e => setType(e.target.value as PlayType)} className={inp}>{TYPES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
            <div><label className="text-slate-300 text-sm font-medium mb-1.5 block">Tags</label><input type="text" value={tags} onChange={e => setTags(e.target.value)} placeholder="PnR, Quick Hitter" className={inp} /></div>
            <div><label className="text-slate-300 text-sm font-medium mb-1.5 block">Notes</label><textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Coaching notes..." rows={3} className={`${inp} resize-none`} /></div>
          </div>}
          <div className="flex gap-3 mt-6">
            {step > 1 && <button onClick={() => setStep(s => (s - 1) as 1 | 2 | 3)} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-all">Back</button>}
            {step < 3 ? <button onClick={() => setStep(s => (s + 1) as 1 | 2 | 3)} className="flex-1 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-semibold transition-all">Next</button>
              : <button onClick={() => { onCreate({ court, situation: sit, formation: form, name: name.trim() || 'Untitled Play', type, tags: tags.split(',').map(t => t.trim()).filter(Boolean), notes }); onClose(); }} className="flex-1 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-semibold transition-all">Create Play</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function LibraryView() {
  const { plays, openPlay, createPlay, searchQuery, filterSituation, sortBy, setSearchQuery, setFilterSituation, setSortBy } = useStore();
  const [showModal, setShowModal] = useState(false);
  const SITS: SituationType[] = ['Halfcourt', 'BLOB', 'SLOB', 'Transition', 'Custom'];
  const filtered = useMemo(() => {
    let list = [...plays];
    if (searchQuery.trim()) { const q = searchQuery.toLowerCase(); list = list.filter(p => p.name.toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q)) || p.situation.toLowerCase().includes(q)); }
    if (filterSituation) list = list.filter(p => p.situation === filterSituation);
    if (sortBy === 'recent') list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    else if (sortBy === 'az') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => a.type.localeCompare(b.type));
    return list;
  }, [plays, searchQuery, filterSituation, sortBy]);
  const chip = (a: boolean) => `px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${a ? 'bg-orange-500 text-white' : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-500'}`;
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3"><div className="w-8 h-8 rounded-lg bg-orange-500 flex items-center justify-center"><span className="text-white text-sm font-bold">CV</span></div><span className="text-white font-bold text-lg tracking-tight">CourtVision <span className="text-orange-500">Pro</span></span></div>
          <div className="flex-1 max-w-md relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input type="text" placeholder="Search plays, tags..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-9 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-orange-500" />
            {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">✕</button>}
          </div>
          <button onClick={() => setShowModal(true)} className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded-xl font-semibold text-sm transition-all shadow-lg shadow-orange-900/30 whitespace-nowrap"><span className="text-lg leading-none">+</span>New Play</button>
        </div>
      </header>
      <div className="max-w-7xl mx-auto px-6 py-6 w-full flex-1">
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setFilterSituation(null)} className={chip(!filterSituation)}>All</button>
            {SITS.map(s => <button key={s} onClick={() => setFilterSituation(filterSituation === s ? null : s)} className={chip(filterSituation === s)}>{s}</button>)}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2"><span className="text-slate-500 text-xs">Sort:</span>{(['recent', 'az', 'type'] as const).map(s => <button key={s} onClick={() => setSortBy(s)} className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${sortBy === s ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}>{s === 'recent' ? 'Recent' : s === 'az' ? 'A–Z' : 'Type'}</button>)}</div>
          <span className="text-slate-500 text-xs">{filtered.length} play{filtered.length !== 1 ? 's' : ''}</span>
        </div>
        {filtered.length > 0
          ? <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">{filtered.map(p => <PlayCard key={p.id} play={p} onOpen={() => openPlay(p.id)} />)}</div>
          : <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center mb-4"><span className="text-2xl">🏀</span></div>
            <h3 className="text-white font-semibold text-lg mb-2">{plays.length === 0 ? 'No plays yet' : 'No plays match'}</h3>
            <p className="text-slate-400 text-sm mb-6 max-w-xs">{plays.length === 0 ? 'Start building your playbook.' : 'Try adjusting your search or filters.'}</p>
            {plays.length === 0 && <button onClick={() => setShowModal(true)} className="px-6 py-3 bg-orange-500 hover:bg-orange-400 text-white rounded-xl font-semibold transition-all">Create First Play</button>}
          </div>
        }
      </div>
      {showModal && <NewPlayModal onClose={() => setShowModal(false)} onCreate={opts => { createPlay(opts); }} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COURT CANVAS
// ─────────────────────────────────────────────────────────────────────────────

const PLAYER_R = 18, HIT_R = 22, ACT_HIT_R = 14, PAD_C = 28, CP_HANDLE_R = 8;

interface CanvasProps {
  play: Play; frameIndex: number; activeTool: Tool; selection: Selection;
  isAnimating: boolean; animFrame: number;
  onPlayerMove(id: string, fi: number, pos: Pos): void;
  onAddAction(a: Omit<PlayAction, 'id'>): void;
  onAddPlayer(p: Omit<Player, 'id'>): void;
  onSelect(s: Selection): void;
  onDeleteAction(id: string): void;
  onDeletePlayer(id: string): void;
  onAddAnnotation(text: string, x: number, y: number): void;
  onUpdateAction(aid: string, u: Partial<Omit<PlayAction, 'id'>>): void;
}

type DragState =
  | { kind: 'player'; id: string; pos: Pos }
  | { kind: 'cp'; actionId: string; pos: Pos }  // pos in normalized coords
  | null;

const CourtCanvas = forwardRef<HTMLCanvasElement, CanvasProps>(function CourtCanvas(
  { play, frameIndex, activeTool, selection, isAnimating, animFrame,
    onPlayerMove, onAddAction, onAddPlayer, onSelect, onDeleteAction, onDeletePlayer, onAddAnnotation, onUpdateAction },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => canvasRef.current!);

  const [drag, setDrag] = useState<DragState>(null);
  const [actDraw, setActDraw] = useState<{ fromId: string; start: Pos; cur: Pos } | null>(null);

  const getBounds = useCallback((): CB => {
    const c = canvasRef.current;
    if (!c) return { x: PAD_C, y: PAD_C, width: 200, height: 188 };
    return { x: PAD_C, y: PAD_C, width: c.width - PAD_C * 2, height: c.height - PAD_C * 2 };
  }, []);

  const toPx = useCallback((nx: number, ny: number): Pos => {
    const b = getBounds(); return { x: b.x + nx * b.width, y: b.y + ny * b.height };
  }, [getBounds]);

  const toNorm = useCallback((px: number, py: number): Pos => {
    const b = getBounds();
    return { x: Math.max(0, Math.min(1, (px - b.x) / b.width)), y: Math.max(0, Math.min(1, (py - b.y) / b.height)) };
  }, [getBounds]);

  const getPos = useCallback((pl: Player, fi: number): Pos => {
    if (drag?.kind === 'player' && drag.id === pl.id) return drag.pos;
    return pl.positions[fi] ?? pl.positions[0] ?? { x: 0.5, y: 0.5 };
  }, [drag]);

  // Get control point in pixel space for a given action
  const getCPPx = useCallback((action: PlayAction, fromPx: Pos, toPx_: Pos): Pos => {
    if (drag?.kind === 'cp' && drag.actionId === action.id) {
      return toPx(drag.pos.x, drag.pos.y);
    }
    if (action.controlPoint) {
      return toPx(action.controlPoint.x, action.controlPoint.y);
    }
    return defaultCP(fromPx, toPx_);
  }, [drag, toPx]);

  const findPlayer = useCallback((px: number, py: number): Player | null => {
    const fi = isAnimating ? animFrame : frameIndex;
    for (const pl of play.players) {
      const { x, y } = toPx(getPos(pl, fi).x, getPos(pl, fi).y);
      if (Math.hypot(px - x, py - y) <= HIT_R) return pl;
    }
    return null;
  }, [play.players, frameIndex, animFrame, isAnimating, getPos, toPx]);

  const findAction = useCallback((px: number, py: number): PlayAction | null => {
    const fi = frameIndex;
    for (const a of play.actions.filter(a => a.frameIndex === fi)) {
      const fp = play.players.find(p => p.id === a.fromPlayerId); if (!fp) continue;
      const fromPx_ = toPx(getPos(fp, fi).x, getPos(fp, fi).y);
      let tp0 = a.toPosition;
      if (!tp0 && a.toPlayerId) { const tp = play.players.find(p => p.id === a.toPlayerId); if (tp) tp0 = getPos(tp, fi); }
      if (!tp0) continue;
      const toPx_ = toPx(tp0.x, tp0.y);

      if (a.type === 'screen') {
        // For screen, check the straight line
        const sf = 0.85, sp = { x: fromPx_.x + (toPx_.x - fromPx_.x) * sf, y: fromPx_.y + (toPx_.y - fromPx_.y) * sf };
        if (isNearCurve(px, py, fromPx_, sp, sp, ACT_HIT_R)) return a;
      } else {
        const cpPx_ = getCPPx(a, fromPx_, toPx_);
        if (a.controlPoint || drag?.kind !== 'cp') {
          if (isNearCurve(px, py, fromPx_, cpPx_, toPx_, ACT_HIT_R)) return a;
        } else {
          // Straight line check
          const mx = (fromPx_.x + toPx_.x) / 2, my = (fromPx_.y + toPx_.y) / 2;
          if (Math.hypot(px - mx, py - my) < ACT_HIT_R) return a;
          if (Math.hypot(px - (fromPx_.x * 3 + toPx_.x) / 4, py - (fromPx_.y * 3 + toPx_.y) / 4) < ACT_HIT_R) return a;
          if (Math.hypot(px - (fromPx_.x + toPx_.x * 3) / 4, py - (fromPx_.y + toPx_.y * 3) / 4) < ACT_HIT_R) return a;
        }
      }
    }
    return null;
  }, [play, frameIndex, getPos, toPx, getCPPx, drag]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const W = canvas.width, H = canvas.height, b = getBounds();
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
    play.court === 'full' ? drawFull(ctx, b) : drawHalf(ctx, b);
    const fi = isAnimating ? animFrame : frameIndex;

    // Draw actions
    play.actions.filter(a => a.frameIndex === fi).forEach(a => {
      const fp = play.players.find(p => p.id === a.fromPlayerId); if (!fp) return;
      const fromPx_ = toPx(getPos(fp, fi).x, getPos(fp, fi).y);
      let tp0 = a.toPosition;
      if (!tp0 && a.toPlayerId) { const tp = play.players.find(p => p.id === a.toPlayerId); if (tp) tp0 = getPos(tp, fi); }
      if (!tp0) return;
      const toPx_ = toPx(tp0.x, tp0.y);
      const sel = selection.type === 'action' && selection.id === a.id;

      // Get control point (only use bezier if there's a stored controlPoint or live drag)
      const hasCurve = a.controlPoint || (drag?.kind === 'cp' && drag.actionId === a.id);
      const cpPx_ = hasCurve ? getCPPx(a, fromPx_, toPx_) : undefined;

      drawArrow(ctx, fromPx_, toPx_, a.type, sel ? '#f97316' : '#fbbf24', sel, cpPx_);

      // Draw control point handle when action is selected and not a screen
      if (sel && a.type !== 'screen' && !isAnimating) {
        const handlePos = getCPPx(a, fromPx_, toPx_);
        // Dashed line from midpoint to handle
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(249,115,22,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo((fromPx_.x + toPx_.x) / 2, (fromPx_.y + toPx_.y) / 2);
        ctx.lineTo(handlePos.x, handlePos.y);
        ctx.stroke();
        ctx.restore();
        // Handle circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(handlePos.x, handlePos.y, CP_HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = a.controlPoint || (drag?.kind === 'cp' && drag.actionId === a.id) ? '#f97316' : 'rgba(249,115,22,0.4)';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    });

    // Draw in-progress action
    if (actDraw) {
      const fp_ = toPx(actDraw.start.x, actDraw.start.y);
      const cp_ = toPx(actDraw.cur.x, actDraw.cur.y);
      ctx.save(); ctx.globalAlpha = 0.6;
      drawArrow(ctx, fp_, cp_, activeTool, '#f97316', false);
      ctx.restore();
    }

    // Draw players
    play.players.forEach(pl => {
      const pos = getPos(pl, fi), { x, y } = toPx(pos.x, pos.y);
      const sel = selection.type === 'player' && selection.id === pl.id, off = pl.team === 'offense';
      ctx.save();
      ctx.shadowColor = sel ? '#f97316' : off ? 'rgba(37,99,235,0.5)' : 'rgba(220,38,38,0.5)';
      ctx.shadowBlur = sel ? 16 : 8;
      ctx.beginPath(); ctx.arc(x, y, PLAYER_R, 0, Math.PI * 2);
      const g = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, PLAYER_R);
      g.addColorStop(0, off ? '#3b82f6' : '#ef4444'); g.addColorStop(1, off ? '#1d4ed8' : '#b91c1c');
      ctx.fillStyle = g; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = sel ? '#f97316' : 'rgba(255,255,255,0.25)'; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.stroke();
      if (sel) { ctx.beginPath(); ctx.arc(x, y, PLAYER_R + 6, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(249,115,22,0.4)'; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.restore();
      ctx.save(); ctx.font = `bold ${pl.label.length > 2 ? '9' : '11'}px system-ui`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(pl.label, x, y + 0.5); ctx.restore();
    });

    // Draw annotations
    (play.annotations ?? []).filter(a => a.frameIndex === fi).forEach(a => {
      const { x, y } = toPx(a.x, a.y);
      ctx.save(); ctx.font = 'bold 13px system-ui'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3; ctx.strokeText(a.text, x, y); ctx.fillStyle = '#fbbf24'; ctx.fillText(a.text, x, y); ctx.restore();
    });

    // Draw in-progress action endpoint dot
    if (actDraw) {
      const cp_ = toPx(actDraw.cur.x, actDraw.cur.y);
      ctx.save(); ctx.beginPath(); ctx.arc(cp_.x, cp_.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#f97316'; ctx.globalAlpha = 0.8; ctx.fill(); ctx.restore();
    }
  }, [play, frameIndex, animFrame, isAnimating, selection, drag, actDraw, activeTool, getBounds, toPx, getPos, getCPPx]);

  useEffect(() => {
    const con = containerRef.current; if (!con) return;
    const obs = new ResizeObserver(() => {
      const c = canvasRef.current; if (!c) return;
      const w = con.clientWidth, ratio = play.court === 'full' ? (94 / 50) : (47 / 50), h = Math.round(w * ratio) + PAD_C * 2;
      if (c.width !== w || c.height !== h) { c.width = Math.max(w, 100); c.height = Math.max(h, 100); }
      draw();
    });
    obs.observe(con); return () => obs.disconnect();
  }, [play.court]); // eslint-disable-line

  useEffect(() => { draw(); }, [draw]);

  const getCP_ = (e: React.MouseEvent) => {
    const c = canvasRef.current!, r = c.getBoundingClientRect();
    return { px: (e.clientX - r.left) * (c.width / r.width), py: (e.clientY - r.top) * (c.height / r.height) };
  };

  const onDown = (e: React.MouseEvent) => {
    if (isAnimating) return;
    const { px, py } = getCP_(e), n = toNorm(px, py);
    const fi = frameIndex;

    // When select tool: first check CP handle of selected action
    if (activeTool === 'select' && selection.type === 'action' && selection.id) {
      const selAct = play.actions.find(a => a.id === selection.id);
      if (selAct && selAct.type !== 'screen') {
        const sfp = play.players.find(p => p.id === selAct.fromPlayerId);
        if (sfp) {
          const fromPx_ = toPx(getPos(sfp, fi).x, getPos(sfp, fi).y);
          let tp0 = selAct.toPosition;
          if (!tp0 && selAct.toPlayerId) { const tp = play.players.find(p => p.id === selAct.toPlayerId); if (tp) tp0 = getPos(tp, fi); }
          if (tp0) {
            const toPx_ = toPx(tp0.x, tp0.y);
            const handlePx = getCPPx(selAct, fromPx_, toPx_);
            if (Math.hypot(px - handlePx.x, py - handlePx.y) <= CP_HANDLE_R + 4) {
              // Start dragging the control point
              const initNorm = selAct.controlPoint ?? toNorm(handlePx.x, handlePx.y);
              setDrag({ kind: 'cp', actionId: selAct.id, pos: initNorm });
              return;
            }
          }
        }
      }
    }

    switch (activeTool) {
      case 'select': {
        const pl = findPlayer(px, py);
        if (pl) { onSelect({ type: 'player', id: pl.id }); setDrag({ kind: 'player', id: pl.id, pos: getPos(pl, fi) }); }
        else { const a = findAction(px, py); onSelect(a ? { type: 'action', id: a.id } : { type: null, id: null }); }
        break;
      }
      case 'cut': case 'pass': case 'dribble': case 'screen': case 'handoff': {
        const pl = findPlayer(px, py);
        if (pl) setActDraw({ fromId: pl.id, start: getPos(pl, fi), cur: n });
        break;
      }
      case 'place-offense':
        onAddPlayer({ team: 'offense', label: String(play.players.filter(p => p.team === 'offense').length + 1), positions: { [fi]: n } }); break;
      case 'place-defense':
        onAddPlayer({ team: 'defense', label: `X${play.players.filter(p => p.team === 'defense').length + 1}`, positions: { [fi]: n } }); break;
      case 'text': { const t = window.prompt('Annotation:'); if (t?.trim()) onAddAnnotation(t.trim(), n.x, n.y); break; }
      case 'eraser': {
        const pl = findPlayer(px, py); if (pl) { onDeletePlayer(pl.id); break; }
        const a = findAction(px, py); if (a) onDeleteAction(a.id); break;
      }
    }
  };

  const onMove = (e: React.MouseEvent) => {
    if (isAnimating) return;
    const { px, py } = getCP_(e), n = toNorm(px, py);
    if (drag?.kind === 'player') setDrag(d => d ? { ...d, pos: n } : null);
    if (drag?.kind === 'cp') setDrag(d => d ? { ...d, pos: n } : null);
    if (actDraw) setActDraw(d => d ? { ...d, cur: n } : null);
    const c = canvasRef.current; if (!c) return;
    // Cursor
    if (activeTool === 'select') {
      if (selection.type === 'action' && selection.id) {
        const selAct = play.actions.find(a => a.id === selection.id);
        if (selAct && selAct.type !== 'screen') {
          const sfp = play.players.find(p => p.id === selAct.fromPlayerId);
          if (sfp) {
            const fromPx_ = toPx(getPos(sfp, frameIndex).x, getPos(sfp, frameIndex).y);
            let tp0 = selAct.toPosition; if (!tp0 && selAct.toPlayerId) { const tp = play.players.find(p => p.id === selAct.toPlayerId); if (tp) tp0 = getPos(tp, frameIndex); }
            if (tp0) {
              const toPx_ = toPx(tp0.x, tp0.y), hp = getCPPx(selAct, fromPx_, toPx_);
              if (Math.hypot(px - hp.x, py - hp.y) <= CP_HANDLE_R + 4) { c.style.cursor = 'grab'; return; }
            }
          }
        }
      }
      c.style.cursor = findPlayer(px, py) ? (drag?.kind === 'player' ? 'grabbing' : 'grab') : 'default';
    } else if (['cut', 'pass', 'dribble', 'screen', 'handoff'].includes(activeTool)) {
      c.style.cursor = findPlayer(px, py) ? 'crosshair' : 'default';
    } else if (activeTool === 'eraser') c.style.cursor = 'cell';
    else c.style.cursor = 'crosshair';
  };

  const onUp = (e: React.MouseEvent) => {
    if (isAnimating) return;
    const { px, py } = getCP_(e), n = toNorm(px, py);
    if (drag?.kind === 'player') { onPlayerMove(drag.id, frameIndex, drag.pos); setDrag(null); }
    if (drag?.kind === 'cp') {
      onUpdateAction(drag.actionId, { controlPoint: drag.pos });
      setDrag(null);
    }
    if (actDraw) {
      const tp = findPlayer(px, py);
      if (!tp || tp.id !== actDraw.fromId) {
        const len = Math.hypot(n.x - actDraw.start.x, n.y - actDraw.start.y);
        if (len > 0.02) onAddAction({ type: activeTool as ActionType, fromPlayerId: actDraw.fromId, toPlayerId: tp?.id, toPosition: !tp ? n : undefined, frameIndex });
      }
      setActDraw(null);
    }
  };

  const onLeave = () => {
    if (drag?.kind === 'player') { onPlayerMove(drag.id, frameIndex, drag.pos); setDrag(null); }
    if (drag?.kind === 'cp') { onUpdateAction(drag.actionId, { controlPoint: drag.pos }); setDrag(null); }
    setActDraw(null);
  };

  return (
    <div ref={containerRef} className="w-full relative select-none" style={{ maxWidth: play.court === 'full' ? '55vh' : '80vh', margin: '0 auto' }}>
      <canvas ref={canvasRef} className="w-full block rounded-xl shadow-2xl shadow-black/60"
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onLeave}
        style={{ touchAction: 'none' }} />
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL PALETTE
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_DEFS: { id: Tool; label: string; key: string; icon: React.ReactNode; group?: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M5 3l14 9-7 1-3 7z" /></svg> },
  { id: 'cut', label: 'Cut', key: 'C', group: 'action', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M5 19L19 5m0 0l-6 0m6 0l0 6" /></svg> },
  { id: 'pass', label: 'Pass', key: 'P', group: 'action', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M5 12h10M14 8l4 4-4 4" strokeDasharray="3 2" /></svg> },
  { id: 'dribble', label: 'Dribble', key: 'D', group: 'action', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M4 12 Q7 8 10 12 Q13 16 16 12 Q19 8 20 10" /><path d="M18 10l2 2-2 0" /></svg> },
  { id: 'screen', label: 'Screen', key: 'S', group: 'action', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M5 12h11" /><path d="M16 8v8" /></svg> },
  { id: 'handoff', label: 'Handoff', key: 'H', group: 'action', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M12 5a7 7 0 010 14M12 5v14" /><path d="M8 9l4-4 4 4" /></svg> },
  { id: 'place-offense', label: 'Offense', key: 'O', group: 'place', icon: <svg viewBox="0 0 24 24" className="w-4 h-4"><circle cx="12" cy="12" r="8" fill="#3b82f6" /><text x="12" y="16" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">O</text></svg> },
  { id: 'place-defense', label: 'Defense', key: 'X', group: 'place', icon: <svg viewBox="0 0 24 24" className="w-4 h-4"><circle cx="12" cy="12" r="8" fill="#ef4444" /><text x="12" y="16" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">X</text></svg> },
  { id: 'text', label: 'Text', key: 'T', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M20 20H7L3 16l11-11 6 6-3.5 3.5" /><path d="M6 17.5L10 13.5" /></svg> },
];

function ToolPalette() {
  const { activeTool, setActiveTool } = useStore();
  return (
    <div className="flex items-center gap-1 px-4 py-2 bg-slate-900 border-t border-slate-800 flex-wrap shrink-0">
      <span className="text-slate-500 text-xs mr-1">Tools:</span>
      {TOOL_DEFS.map((t, i) => {
        const prev = i > 0 ? TOOL_DEFS[i - 1].group : undefined, div = t.group !== prev && i > 0 && (t.group || prev);
        return (
          <div key={t.id} className="flex items-center gap-1">
            {div && <div className="w-px h-5 bg-slate-700 mx-1" />}
            <button onClick={() => setActiveTool(t.id)} title={`${t.label} [${t.key}]`}
              className={`relative group w-9 h-9 flex items-center justify-center rounded-lg transition-all ${activeTool === t.id ? 'bg-orange-500 text-white shadow-lg shadow-orange-900/30' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}>
              {t.icon}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-700 text-white text-[10px] rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 border border-slate-600">{t.label} [{t.key}]</div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FRAME TIMELINE
// ─────────────────────────────────────────────────────────────────────────────

function FrameTimeline() {
  const { plays, activePlayId, currentFrame, setCurrentFrame, addFrame, duplicateFrame, deleteFrame, setSelection } = useStore();
  const play = plays.find(p => p.id === activePlayId); if (!play) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 border-t border-slate-800 overflow-x-auto shrink-0">
      <span className="text-slate-500 text-xs shrink-0 font-medium">Frames:</span>
      <div className="flex items-center gap-1.5">
        {play.frames.map(f => (
          <div key={f.index} className="relative group">
            <button onClick={() => { setCurrentFrame(f.index); setSelection({ type: 'frame', id: String(f.index) }); }}
              className={`h-10 min-w-[52px] px-3 rounded-lg border text-xs font-semibold transition-all ${currentFrame === f.index ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600 hover:text-white'}`}>
              <div className="text-[10px] text-slate-500 font-normal mb-0.5">F{f.index + 1}</div>
              <div>{Math.round(f.durationMs / 100) / 10}s</div>
            </button>
            {play.frames.length > 1 && <button onClick={ev => { ev.stopPropagation(); deleteFrame(play.id, f.index); }} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-600 text-white text-[9px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10 hover:bg-red-500">✕</button>}
          </div>
        ))}
        <button onClick={() => addFrame(play.id)} className="h-10 min-w-[40px] px-2 rounded-lg border border-dashed border-slate-700 text-slate-500 hover:border-orange-500/60 hover:text-orange-400 text-base font-bold transition-all" title="Add frame">+</button>
        <button onClick={() => duplicateFrame(play.id, currentFrame)} className="h-10 px-2.5 rounded-lg border border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-300 text-[11px] transition-all" title="Duplicate">⧉</button>
      </div>
      <div className="flex-1" />
      <span className="text-slate-600 text-[10px] shrink-0">{play.frames.length} frame{play.frames.length !== 1 ? 's' : ''}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPECTOR PANEL
// ─────────────────────────────────────────────────────────────────────────────

const IC = "w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors";
const SC = "w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm focus:outline-none focus:border-orange-500 transition-colors cursor-pointer";

function IF({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><label className="text-slate-400 text-[11px]">{label}</label>{children}</div>;
}
function IS({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="text-slate-500 text-[10px] font-semibold uppercase tracking-wider mb-2.5">{title}</div><div className="space-y-2.5">{children}</div></div>;
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="bg-slate-800 rounded-lg px-3 py-2"><div className="text-slate-500 text-[10px] mb-0.5">{label}</div><div className="text-white text-sm font-semibold">{value}</div></div>;
}

function InspectorPanel() {
  const { plays, activePlayId, selection, updatePlayMeta, updatePlayer, updateAction, updateFrame, deletePlayer, deleteAction } = useStore();
  const play = plays.find(p => p.id === activePlayId); if (!play) return null;
  const selPl = selection.type === 'player' ? play.players.find(p => p.id === selection.id) : null;
  const selAct = selection.type === 'action' ? play.actions.find(a => a.id === selection.id) : null;
  const selFi = selection.type === 'frame' ? Number(selection.id) : null;
  const selF = selFi != null ? play.frames.find(f => f.index === selFi) : null;

  const AT: ActionType[] = ['cut', 'pass', 'dribble', 'screen', 'handoff', 'pop', 'roll', 'flare'];
  const PT: PlayType[] = ['Custom', 'Horns', 'Floppy', 'Spain PnR', 'BLOB', 'SLOB', 'Transition'];
  const ST: SituationType[] = ['Halfcourt', 'BLOB', 'SLOB', 'Transition', 'Custom'];

  return (
    <div className="w-[272px] shrink-0 border-l border-slate-800 bg-slate-900 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 shrink-0">
        <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">Inspector</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-5">

        {/* No selection → Play metadata */}
        {!selection.type && (<>
          <IS title="Play Info">
            <IF label="Name"><input className={IC} value={play.name} onChange={e => updatePlayMeta(play.id, { name: e.target.value })} /></IF>
            <IF label="Type"><select className={SC} value={play.type} onChange={e => updatePlayMeta(play.id, { type: e.target.value as PlayType })}>{PT.map(t => <option key={t} value={t}>{t}</option>)}</select></IF>
            <IF label="Situation"><select className={SC} value={play.situation} onChange={e => updatePlayMeta(play.id, { situation: e.target.value as SituationType })}>{ST.map(s => <option key={s} value={s}>{s}</option>)}</select></IF>
            <IF label="Tags"><input className={IC} value={play.tags.join(', ')} onChange={e => updatePlayMeta(play.id, { tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} placeholder="PnR, Quick Hitter" /></IF>
          </IS>
          <IS title="Notes"><textarea className={`${IC} resize-none`} rows={5} value={play.notes} onChange={e => updatePlayMeta(play.id, { notes: e.target.value })} placeholder="Coaching notes..." /></IS>
          <IS title="Overview">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Players" value={play.players.length} /><Stat label="Frames" value={play.frames.length} />
              <Stat label="Actions" value={play.actions.length} /><Stat label="Court" value={play.court === 'half' ? 'Half' : 'Full'} />
            </div>
          </IS>
          <p className="text-slate-600 text-[11px] text-center pt-1">Click a player or action to inspect it.</p>
        </>)}

        {/* Player selected */}
        {selPl && (<IS title="Player">
          <IF label="Label"><input className={IC} value={selPl.label} onChange={e => updatePlayer(play.id, selPl.id, { label: e.target.value })} /></IF>
          <IF label="Team">
            <div className="grid grid-cols-2 gap-2">
              {(['offense', 'defense'] as const).map(tm => (
                <button key={tm} onClick={() => updatePlayer(play.id, selPl.id, { team: tm })}
                  className={`py-1.5 rounded-lg text-xs font-medium border transition-all capitalize ${selPl.team === tm ? (tm === 'offense' ? 'border-blue-500 bg-blue-500/20 text-blue-400' : 'border-red-500 bg-red-500/20 text-red-400') : 'border-slate-600 text-slate-400 hover:border-slate-500 hover:text-white'}`}>{tm}</button>
              ))}
            </div>
          </IF>
          <IF label="Notes"><input className={IC} value={selPl.notes ?? ''} onChange={e => updatePlayer(play.id, selPl.id, { notes: e.target.value })} placeholder="Player note..." /></IF>
          <button onClick={() => deletePlayer(play.id, selPl.id)} className="w-full py-2 mt-2 rounded-lg bg-red-900/30 border border-red-800/50 text-red-400 text-xs font-medium hover:bg-red-900/50 transition-all">Delete Player</button>
        </IS>)}

        {/* Action selected */}
        {selAct && (<IS title="Action">
          <IF label="Type">
            <select className={SC} value={selAct.type} onChange={e => updateAction(play.id, selAct.id, { type: e.target.value as ActionType })}>
              {AT.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </IF>
          <IF label="From">
            <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm">
              <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                {play.players.find(p => p.id === selAct.fromPlayerId)?.label?.charAt(0) ?? '?'}
              </div>
              <span className="text-white">{play.players.find(p => p.id === selAct.fromPlayerId)?.label ?? 'Unknown'}</span>
            </div>
          </IF>
          {selAct.toPlayerId && (
            <IF label="To">
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                  {play.players.find(p => p.id === selAct.toPlayerId)?.label?.charAt(0) ?? '?'}
                </div>
                <span className="text-white">{play.players.find(p => p.id === selAct.toPlayerId)?.label ?? 'Unknown'}</span>
              </div>
            </IF>
          )}
          {selAct.toPosition && !selAct.toPlayerId && (
            <IF label="To Position">
              <span className="text-slate-400 text-sm font-mono">({selAct.toPosition.x.toFixed(2)}, {selAct.toPosition.y.toFixed(2)})</span>
            </IF>
          )}
          <IF label="Frame"><span className="text-slate-400 text-sm">Frame {selAct.frameIndex + 1}</span></IF>
          <IF label="Note">
            <input className={IC} value={selAct.note ?? ''} onChange={e => updateAction(play.id, selAct.id, { note: e.target.value })} placeholder="Action note..." />
          </IF>

          {/* Curve status */}
          <div className="flex items-center justify-between px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded-lg">
            <span className="text-slate-400 text-xs">Curve</span>
            <span className={`text-xs font-medium ${selAct.controlPoint ? 'text-orange-400' : 'text-slate-500'}`}>
              {selAct.controlPoint ? 'Custom' : 'Straight (drag handle)'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-1">
            {selAct.controlPoint && (
              <button
                onClick={() => updateAction(play.id, selAct.id, { controlPoint: undefined })}
                className="py-2 rounded-lg bg-slate-700 border border-slate-600 text-slate-300 text-xs font-medium hover:bg-slate-600 transition-all"
              >
                Reset Curve
              </button>
            )}
            <button
              onClick={() => deleteAction(play.id, selAct.id)}
              className={`py-2 rounded-lg bg-red-900/30 border border-red-800/50 text-red-400 text-xs font-medium hover:bg-red-900/50 transition-all ${selAct.controlPoint ? '' : 'col-span-2'}`}
            >
              Delete Action
            </button>
          </div>

          {selAct.type !== 'screen' && (
            <p className="text-slate-600 text-[11px] text-center">Drag the orange circle on the canvas to bend this action's path.</p>
          )}
        </IS>)}

        {/* Frame selected */}
        {selF != null && (<IS title={`Frame ${selF.index + 1}`}>
          <IF label="Duration">
            <div className="flex items-center gap-2">
              <input type="range" min={200} max={4000} step={100} value={selF.durationMs} onChange={e => updateFrame(play.id, selF.index, { durationMs: Number(e.target.value) })} className="flex-1 accent-orange-500" />
              <span className="text-slate-300 text-sm w-14 text-right font-mono">{(selF.durationMs / 1000).toFixed(1)}s</span>
            </div>
          </IF>
          <IF label="Auto-advance">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <div onClick={() => updateFrame(play.id, selF.index, { autoAdvance: !selF.autoAdvance })} className={`w-10 h-5 rounded-full transition-colors relative ${selF.autoAdvance ? 'bg-orange-500' : 'bg-slate-600'}`}>
                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${selF.autoAdvance ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-slate-300 text-sm">{selF.autoAdvance ? 'On' : 'Off'}</span>
            </label>
          </IF>
        </IS>)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAY LIST PANEL
// ─────────────────────────────────────────────────────────────────────────────

function PlayListPanel() {
  const { plays, activePlayId, openPlay, createPlay } = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = plays.filter(p => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()));
  const handleNew = () => createPlay({ court: 'half', type: 'Custom', situation: 'Halfcourt', formation: 'Horns', name: 'Untitled Play', tags: [], notes: '' });
  if (collapsed) return (
    <div className="w-10 flex flex-col items-center border-r border-slate-800 bg-slate-900 py-3 gap-3 shrink-0">
      <button onClick={() => setCollapsed(false)} className="text-slate-400 hover:text-white w-7 h-7 flex items-center justify-center rounded hover:bg-slate-700 transition-colors">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
      </button>
      <div className="text-slate-600 text-[10px]" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>{plays.length} plays</div>
    </div>
  );
  return (
    <div className="w-[240px] flex flex-col border-r border-slate-800 bg-slate-900 shrink-0 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-800">
        <span className="text-slate-400 text-xs font-medium uppercase tracking-wider">Plays</span>
        <button onClick={() => setCollapsed(true)} className="text-slate-500 hover:text-slate-300 w-6 h-6 flex items-center justify-center rounded hover:bg-slate-700">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
      </div>
      <div className="px-3 py-2 border-b border-slate-800">
        <button onClick={handleNew} className="w-full flex items-center gap-2 px-3 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded-lg text-sm font-semibold transition-all"><span className="text-base leading-none">+</span>New Play</button>
      </div>
      <div className="px-3 py-2 border-b border-slate-800">
        <input type="text" placeholder="Search plays..." value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-orange-500" />
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 && <div className="px-3 py-4 text-center text-slate-500 text-xs">No plays found</div>}
        {filtered.map(p => (
          <button key={p.id} onClick={() => openPlay(p.id)} className={`w-full text-left px-3 py-2.5 transition-all border-l-2 ${p.id === activePlayId ? 'border-l-orange-500 bg-orange-500/10 text-orange-400' : 'border-l-transparent text-slate-300 hover:bg-slate-800 hover:text-white'}`}>
            <div className="text-sm font-medium leading-tight truncate">{p.name}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{p.situation} · {p.frames.length} frame{p.frames.length !== 1 ? 's' : ''}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────────────────────────────────────────

function TopBar({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement> }) {
  const { plays, activePlayId, savedStatus, backToLibrary, updatePlayMeta, undo, redo, undoStack, redoStack, isAnimating, setIsAnimating, setCurrentFrame, show3D, setShow3D } = useStore();
  const play = plays.find(p => p.id === activePlayId);
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(play?.name ?? '');
  const nameRef = useRef<HTMLInputElement>(null);
  if (!play) return null;
  const handleClick = () => { setNameVal(play.name); setEditing(true); setTimeout(() => nameRef.current?.select(), 0); };
  const handleBlur = () => { setEditing(false); if (nameVal.trim() && nameVal !== play.name) updatePlayMeta(play.id, { name: nameVal.trim() }); };
  const handleAnimate = () => {
    if (isAnimating) { setIsAnimating(false); return; }
    setIsAnimating(true); let f = 0;
    const adv = () => { if (f >= play.frames.length) { setIsAnimating(false); setCurrentFrame(0); return; } setCurrentFrame(f); setTimeout(adv, play.frames[f++]?.durationMs ?? 1200); }; adv();
  };
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-900 border-b border-slate-800 min-h-[52px] shrink-0">
      <button onClick={backToLibrary} className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors shrink-0">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        <span className="hidden sm:inline">Library</span>
      </button>
      <div className="w-px h-5 bg-slate-700 shrink-0" />
      <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center shrink-0"><span className="text-white text-[10px] font-bold">CV</span></div>
      <div className="flex-1 min-w-0">
        {editing
          ? <input ref={nameRef} type="text" value={nameVal} onChange={e => setNameVal(e.target.value)} onBlur={handleBlur} onKeyDown={e => { if (e.key === 'Enter') handleBlur(); if (e.key === 'Escape') setEditing(false); }} className="bg-slate-700 border border-orange-500 rounded px-2 py-0.5 text-white text-sm font-semibold focus:outline-none w-full max-w-xs" />
          : <button onClick={handleClick} className="text-white text-sm font-semibold hover:text-orange-400 transition-colors truncate block max-w-xs text-left" title="Click to rename">{play.name}</button>
        }
      </div>
      <div className="shrink-0">
        {savedStatus === 'saved'
          ? <span className="text-green-500/70 text-xs flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />Saved</span>
          : <span className="text-slate-400 text-xs flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-orange-400 inline-block animate-pulse" />Unsaved</span>
        }
      </div>
      <div className="w-px h-5 bg-slate-700 shrink-0" />
      <div className="flex gap-1 shrink-0">
        <button onClick={undo} disabled={!undoStack.length} title="Undo (Ctrl+Z)" className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm">↩</button>
        <button onClick={redo} disabled={!redoStack.length} title="Redo (Ctrl+Y)" className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm">↪</button>
      </div>
      <div className="w-px h-5 bg-slate-700 shrink-0" />
      <button onClick={() => updatePlayMeta(play.id, { court: play.court === 'half' ? 'full' : 'half' })} className="px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white border border-slate-600 hover:border-slate-500 rounded-lg transition-all shrink-0">{play.court === 'half' ? '½ Court' : 'Full Court'}</button>
      <button onClick={() => setShow3D(!show3D)} className={`px-2.5 py-1 text-xs font-medium border rounded-lg transition-all shrink-0 ${show3D ? 'border-orange-500 text-orange-400 bg-orange-500/10' : 'border-slate-600 text-slate-300 hover:text-white hover:border-slate-500'}`}>3D</button>
      <button onClick={handleAnimate} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 ${isAnimating ? 'bg-orange-500/20 border border-orange-500/50 text-orange-400' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}>
        {isAnimating ? <><span className="w-2 h-2 bg-orange-400 rounded-sm" />Stop</> : <><svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>Animate</>}
      </button>
      <button onClick={() => { if (canvasRef.current) exportPNG(canvasRef.current, play.name); }} title="Export PNG" className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-all shrink-0">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3D VIEW
// ─────────────────────────────────────────────────────────────────────────────

function ThreeScene({ play, frameIndex }: { play: Play; frameIndex: number }) {
  const CW = 28, CD = 15;
  const mx = (nx: number) => (nx - 0.5) * CW;
  const mz = (ny: number) => (ny - 0.5) * CD;
  return (
    <div className="w-full h-full relative" style={{ minHeight: 300 }}>
      <Canvas camera={{ position: [0, 20, 16], fov: 42 }} shadows gl={{ antialias: true }} style={{ background: '#0f172a' }}>
        <ambientLight intensity={0.55} /><directionalLight position={[8, 18, 6]} intensity={0.9} castShadow />
        <pointLight position={[0, 12, 0]} intensity={0.3} />
        <Suspense fallback={null}>
          <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[CW + 1, CD + 1]} /><meshStandardMaterial color="#b8864e" roughness={0.85} /></mesh>
          <lineSegments position={[0, 0.01, 0]}><edgesGeometry args={[new THREE.BoxGeometry(CW, 0.01, CD)]} /><lineBasicMaterial color="white" /></lineSegments>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}><planeGeometry args={[CW, 0.08]} /><meshBasicMaterial color="white" /></mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}><ringGeometry args={[1.75, 1.88, 48]} /><meshBasicMaterial color="white" side={2} /></mesh>
          {[-10.7, 10.7].map(px => <mesh key={px} rotation={[-Math.PI / 2, 0, 0]} position={[px, 0.02, 0]}><planeGeometry args={[4.6, 5.8]} /><meshBasicMaterial color="#a06428" transparent opacity={0.3} /></mesh>)}
          {([-1, 1] as const).map(d => (
            <group key={d} position={[d * (CW / 2 - 1.2), 3.05, 0]}>
              <mesh position={[d * 0.6, -1.5, 0]}><cylinderGeometry args={[0.05, 0.05, 3, 8]} /><meshStandardMaterial color="#888" metalness={0.8} /></mesh>
              <mesh><boxGeometry args={[0.05, 1.07, 1.83]} /><meshStandardMaterial color="white" transparent opacity={0.6} /></mesh>
              <mesh position={[d * 0.3, -0.3, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.225, 0.02, 8, 32]} /><meshStandardMaterial color="orange" metalness={0.6} /></mesh>
            </group>
          ))}
          {play.players.map(pl => {
            const pos = pl.positions[frameIndex] ?? pl.positions[0] ?? { x: 0.5, y: 0.5 };
            const color = pl.team === 'offense' ? '#2563eb' : '#dc2626';
            return (
              <group key={pl.id} position={[mx(pos.x), 0, mz(pos.y)]}>
                <mesh position={[0, 0.65, 0]} castShadow><cylinderGeometry args={[0.22, 0.26, 1.3, 12]} /><meshStandardMaterial color={color} /></mesh>
                <mesh position={[0, 1.5, 0]} castShadow><sphereGeometry args={[0.22, 12, 12]} /><meshStandardMaterial color="#fbbf24" /></mesh>
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}><circleGeometry args={[0.35, 16]} /><meshBasicMaterial color="black" transparent opacity={0.2} /></mesh>
                <DreiText position={[0, 2.1, 0]} fontSize={0.4} color="white" anchorX="center" anchorY="middle" outlineWidth={0.04} outlineColor="black">{pl.label}</DreiText>
              </group>
            );
          })}
        </Suspense>
        <OrbitControls enablePan enableZoom enableRotate minDistance={4} maxDistance={45} maxPolarAngle={Math.PI / 2.05} target={[0, 0, 0]} />
      </Canvas>
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-slate-900/80 backdrop-blur-sm rounded-full text-slate-400 text-[11px] pointer-events-none border border-slate-800">Drag · Scroll · Shift+drag</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ OVERLAY
// ─────────────────────────────────────────────────────────────────────────────

function QuizOverlay({ playId }: { playId: string }) {
  const { plays, closeQuiz } = useStore();
  const play = plays.find(p => p.id === playId);
  const [fi, setFi] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [scores, setScores] = useState<boolean[]>([]);
  const [done, setDone] = useState(false);
  const canRef = useRef<HTMLCanvasElement>(null);

  const drawFrame = useCallback((idx: number, showActs: boolean) => {
    const canvas = canRef.current; if (!canvas || !play) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const W = canvas.width, H = canvas.height, P = 12, b = { x: P, y: P, width: W - P * 2, height: H - P * 2 };
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
    play.court === 'full' ? drawFull(ctx, b) : drawHalf(ctx, b);
    if (showActs) play.actions.filter(a => a.frameIndex === idx).forEach(a => {
      const fp = play.players.find(p => p.id === a.fromPlayerId); if (!fp) return;
      const f0 = fp.positions[idx] ?? fp.positions[0] ?? { x: 0.5, y: 0.5 };
      let t0 = a.toPosition; if (!t0 && a.toPlayerId) { const tp = play.players.find(p => p.id === a.toPlayerId); if (tp) t0 = tp.positions[idx] ?? tp.positions[0]; }
      if (!t0) return;
      const fromPx_ = { x: b.x + f0.x * b.width, y: b.y + f0.y * b.height };
      const toPx_ = { x: b.x + t0.x * b.width, y: b.y + t0.y * b.height };
      const cpPx_ = a.controlPoint ? { x: b.x + a.controlPoint.x * b.width, y: b.y + a.controlPoint.y * b.height } : undefined;
      drawArrow(ctx, fromPx_, toPx_, a.type, '#f97316', false, cpPx_);
    });
    play.players.forEach(pl => {
      const pos = pl.positions[idx] ?? pl.positions[0] ?? { x: 0.5, y: 0.5 };
      const x = b.x + pos.x * b.width, y = b.y + pos.y * b.height, R = 14;
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fillStyle = pl.team === 'offense' ? '#2563eb' : '#dc2626'; ctx.fill();
      ctx.font = 'bold 10px system-ui'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(showActs ? pl.label : '?', x, y + 0.5);
    });
  }, [play]);

  useEffect(() => { if (!done) drawFrame(fi, revealed); }, [fi, revealed, done, drawFrame]);
  if (!play) return null;

  const acts = play.actions.filter(a => a.frameIndex === fi);
  const fc = play.frames.length;
  const handleAnswer = (correct: boolean) => {
    const ns = [...scores, correct]; setScores(ns);
    if (fi >= fc - 1) setDone(true); else { setFi(f => f + 1); setRevealed(false); }
  };
  const pct = fc > 0 ? Math.round((scores.filter(Boolean).length / fc) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={closeQuiz}>
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <h2 className="text-white font-bold text-base">{play.name}</h2>
            <p className="text-slate-400 text-xs mt-0.5">{done ? `Complete — ${scores.filter(Boolean).length}/${fc} correct` : `Frame ${fi + 1} of ${fc}`}</p>
          </div>
          <div className="flex items-center gap-2">
            {!done && <div className="flex gap-1">{play.frames.map((_, i) => <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i < scores.length ? (scores[i] ? 'bg-green-500' : 'bg-red-500') : i === fi ? 'bg-orange-400' : 'bg-slate-600'}`} />)}</div>}
            <button onClick={closeQuiz} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 text-sm">✕</button>
          </div>
        </div>
        <div className="p-5">
          {done ? (
            <div className="text-center">
              <div className="text-6xl mb-4">{pct === 100 ? '🏆' : pct >= 70 ? '💪' : pct >= 40 ? '📚' : '🏀'}</div>
              <div className="text-4xl font-bold text-white mb-1">{pct}%</div>
              <div className="text-slate-400 text-sm mb-6">{scores.filter(Boolean).length}/{fc} frames correct</div>
              <div className="space-y-2 mb-6 text-left">
                {scores.map((s, i) => <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${s ? 'bg-green-900/30' : 'bg-red-900/30'}`}><span>{s ? '✓' : '✗'}</span><span className={s ? 'text-green-400' : 'text-red-400'}>Frame {i + 1}</span></div>)}
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setFi(0); setRevealed(false); setScores([]); setDone(false); }} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-all">Retry</button>
                <button onClick={closeQuiz} className="flex-1 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-sm font-semibold transition-all">Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl overflow-hidden mb-4 bg-slate-900">
                <canvas ref={canRef} width={380} height={play.court === 'full' ? 357 : 179} className="w-full block" />
              </div>
              <p className="text-slate-300 text-sm mb-4 text-center">{revealed ? 'Did you get it right?' : 'What actions happen in this frame?'}</p>
              {revealed && (
                <div className="mb-4 p-3 rounded-xl bg-orange-500/10 border border-orange-500/20">
                  <div className="text-orange-400 text-[11px] font-semibold uppercase tracking-wide mb-2">Actions</div>
                  {acts.length === 0 ? <p className="text-slate-400 text-sm">No actions.</p> : (
                    <ul className="space-y-1.5">{acts.map(a => {
                      const fr = play.players.find(p => p.id === a.fromPlayerId), to = play.players.find(p => p.id === a.toPlayerId);
                      return <li key={a.id} className="text-sm text-slate-300 flex items-center gap-1.5"><span className="font-medium text-white">{fr?.label ?? '?'}</span><span className="text-orange-400">{a.type}</span>{to && <><span className="text-slate-500">→</span><span className="font-medium text-white">{to.label}</span></>}</li>;
                    })}</ul>
                  )}
                </div>
              )}
              {!revealed
                ? <button onClick={() => setRevealed(true)} className="w-full py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold transition-all">Reveal Actions</button>
                : <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => handleAnswer(false)} className="py-2.5 rounded-xl bg-red-900/40 border border-red-800/60 text-red-400 text-sm font-medium hover:bg-red-900/60 transition-all">✗ Missed it</button>
                  <button onClick={() => handleAnswer(true)} className="py-2.5 rounded-xl bg-green-900/40 border border-green-800/60 text-green-400 text-sm font-medium hover:bg-green-900/60 transition-all">✓ Got it</button>
                </div>
              }
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EDITOR VIEW
// ─────────────────────────────────────────────────────────────────────────────

function EditorView() {
  const {
    plays, activePlayId, currentFrame, activeTool, selection,
    isAnimating, animFrame, show3D,
    setSelection, movePlayer, addAction, addPlayer, addAnnotation,
    deleteAction, deletePlayer, setActiveTool, updateAction,
  } = useStore();
  const play = plays.find(p => p.id === activePlayId);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const map: Record<string, string> = { v: 'select', c: 'cut', p: 'pass', d: 'dribble', s: 'screen', h: 'handoff', o: 'place-offense', x: 'place-defense', t: 'text', e: 'eraser' };
      const tool = map[e.key.toLowerCase()]; if (tool) { setActiveTool(tool as Tool); return; }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); useStore.getState().undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); useStore.getState().redo(); }
      if (e.key === 'Escape') setSelection({ type: null, id: null });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveTool, setSelection]);

  if (!play) return (
    <div className="h-screen bg-slate-900 flex items-center justify-center flex-col gap-3 text-slate-400">
      <span className="text-4xl">🏀</span><p className="text-sm">No play selected.</p>
      <button onClick={() => useStore.getState().backToLibrary()} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors">Back to Library</button>
    </div>
  );

  return (
    <div className="h-screen bg-slate-900 flex flex-col overflow-hidden">
      <TopBar canvasRef={canvasRef} />
      <div className="flex flex-1 overflow-hidden min-h-0">
        <PlayListPanel />
        <div className="flex flex-1 flex-col overflow-hidden min-w-0 min-h-0">
          <div className="flex-1 overflow-auto flex items-center justify-center bg-slate-950 p-4 min-h-0">
            {show3D
              ? <div className="w-full h-full relative"><ThreeScene play={play} frameIndex={currentFrame} /></div>
              : <CourtCanvas
                ref={canvasRef} play={play} frameIndex={currentFrame} activeTool={activeTool}
                selection={selection} isAnimating={isAnimating} animFrame={animFrame}
                onPlayerMove={(id, fi, pos) => movePlayer(play.id, id, fi, pos)}
                onAddAction={a => addAction(play.id, a)}
                onAddPlayer={p => addPlayer(play.id, p)}
                onSelect={setSelection}
                onDeleteAction={id => deleteAction(play.id, id)}
                onDeletePlayer={id => deletePlayer(play.id, id)}
                onAddAnnotation={(text, x, y) => addAnnotation(play.id, { text, x, y, frameIndex: currentFrame })}
                onUpdateAction={(aid, u) => updateAction(play.id, aid, u)}
              />
            }
          </div>
          {!show3D && <ToolPalette />}
          <FrameTimeline />
        </div>
        <InspectorPanel />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const { view, quizPlayId } = useStore();
  return (
    <>
      {view === 'library' && <LibraryView />}
      {view === 'editor' && <EditorView />}
      {quizPlayId && <QuizOverlay playId={quizPlayId} />}
    </>
  );
}

export default function Page() {
  return <App />;
}
