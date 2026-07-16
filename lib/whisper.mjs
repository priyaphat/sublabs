import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const PROFILES = new Set(['accurate', 'balanced', 'fast']);

export class WhisperService {
  constructor({ root, model, models = {}, vadModel, port = 4174 }) {
    this.root = root;
    this.models = {
      accurate: models.accurate || model,
      balanced: models.balanced || models.accurate || model,
      fast: models.fast || models.balanced || models.accurate || model,
    };
    this.vadModel = vadModel;
    this.port = port;
    this.child = null;
    this.starting = null;
    this.mode = 'cpu';
    this.requestedProfile = null;
    this.activeProfile = null;
    this.fallback = false;
    this.lastLog = '';
  }

  binaries() {
    return {
      cuda: path.join(this.root, 'tools', 'whisper-cuda', 'Release', 'whisper-server.exe'),
      cpu: path.join(this.root, 'tools', 'whisper', 'Release', 'whisper-server.exe'),
    };
  }

  async exists(file) {
    try { await readFile(file); return true; } catch { return false; }
  }

  profileCandidates(profile = 'accurate') {
    const requested = PROFILES.has(profile) ? profile : 'accurate';
    const binaries = this.binaries();
    const q5 = this.models.balanced || this.models.accurate;
    if (requested === 'fast') return [
      { binary: binaries.cpu, mode: 'cpu', model: this.models.fast || q5, profile: 'fast', beam: 1, bestOf: 1, fallback: false },
    ];
    if (requested === 'balanced') return [
      { binary: binaries.cuda, mode: 'cuda', model: q5, profile: 'balanced', beam: 3, bestOf: 3, fallback: false },
      { binary: binaries.cpu, mode: 'cpu', model: q5, profile: 'balanced', beam: 3, bestOf: 3, fallback: true },
    ];
    return [
      { binary: binaries.cuda, mode: 'cuda', model: this.models.accurate, profile: 'accurate', beam: 5, bestOf: 5, fallback: false },
      { binary: binaries.cpu, mode: 'cpu', model: q5, profile: 'balanced', beam: 3, bestOf: 3, fallback: true },
    ];
  }

  async start(profile = 'accurate') {
    const requested = PROFILES.has(profile) ? profile : 'accurate';
    if (this.child && !this.child.killed && this.requestedProfile === requested) return;
    if (this.starting) return this.starting;
    if (this.child) await this.stop();
    this.starting = this.#start(requested).finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start(profile) {
    const candidates = [];
    for (const candidate of this.profileCandidates(profile)) {
      if (await this.exists(candidate.binary) && await this.exists(candidate.model)) candidates.push(candidate);
    }
    if (!candidates.length) throw new Error('ไม่พบ Whisper binary หรือโมเดลที่ต้องใช้');
    let lastError;
    for (const candidate of candidates) {
      try { return await this.#launch(candidate, profile); }
      catch (error) { lastError = error; await this.stop(); }
    }
    throw lastError || new Error('เปิด Whisper ไม่สำเร็จ');
  }

  async #launch(candidate, requestedProfile) {
    const { binary, mode, model, profile, beam, bestOf, fallback } = candidate;
    this.mode = mode;
    this.requestedProfile = requestedProfile;
    this.activeProfile = profile;
    this.fallback = fallback;
    const args = [
      '-m', model, '-dtw', 'large.v3.turbo', '-bs', String(beam), '-bo', String(bestOf), '-nth', '0.60', '-sns', '-t', profile === 'fast' ? '4' : '6',
      '--vad', '-vm', this.vadModel, '-vt', '0.50', '-vspd', '120', '-vsd', '180', '-vmsd', '30', '-vp', '80', '-vo', '0.10',
      '--host', '127.0.0.1', '--port', String(this.port),
    ];
    if (mode === 'cpu') args.push('-ng');
    this.child = spawn(binary, args, { cwd: this.root, windowsHide: true });
    let log = '';
    this.lastLog = '';
    this.child.stderr.on('data', data => { log = (log + String(data)).slice(-12000); this.lastLog = log; });
    this.child.on('close', () => { this.child = null; });
    for (let index = 0; index < 180; index++) {
      if (!this.child) throw new Error(`Whisper ${mode.toUpperCase()} เปิดไม่สำเร็จ: ${log.slice(-1500)}`);
      try { const response = await fetch(`http://127.0.0.1:${this.port}/`); if (response.status < 500) return; } catch {}
      await wait(500);
    }
    await this.stop();
    throw new Error('Whisper ใช้เวลาเปิดนานเกินกำหนด');
  }

  async transcribe(wav, { language = 'th', prompt = '', signal, vad = false, quality = 'accurate' } = {}) {
    await this.start(quality);
    const bytes = await readFile(wav);
    const perform = async () => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
      form.append('response_format', 'verbose_json');
      form.append('language', language);
      form.append('temperature', '0.0');
      form.append('vad', vad ? 'true' : 'false');
      if (prompt.trim()) form.append('prompt', prompt.trim().slice(0, 2000));
      const response = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal });
      const text = await response.text();
      if (!response.ok) { const error = new Error(text || `Whisper HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
      try { return JSON.parse(text); } catch { throw new Error(`Whisper ส่งผลลัพธ์ไม่ถูกต้อง: ${text.slice(0, 500)}`); }
    };
    try { return await perform(); }
    catch (firstError) {
      if (firstError.name === 'AbortError') throw firstError;
      let error = firstError;
      if (this.mode === 'cuda' && quality !== 'fast' && (!firstError.httpStatus || firstError.httpStatus >= 500)) {
        await this.stop();
        await this.start('balanced');
        try { return await perform(); } catch (secondError) { error = secondError; }
      }
      const noSpeech = /Final speech segments after filtering: 0|past the end of the audio/.test(this.lastLog);
      throw new Error(noSpeech ? 'ไม่พบเสียงพูดที่ชัดเจนในวิดีโอ' : `Whisper หยุดทำงาน: ${this.lastLog.slice(-800) || error.message}`);
    }
  }

  async detectSpeechRegions(wav, { signal } = {}) {
    const first = path.join(this.root, 'tools', this.mode === 'cuda' ? 'whisper-cuda' : 'whisper', 'Release', 'whisper-vad-speech-segments.exe');
    const second = path.join(this.root, 'tools', this.mode === 'cuda' ? 'whisper' : 'whisper-cuda', 'Release', 'whisper-vad-speech-segments.exe');
    const binary = await this.exists(first) ? first : second;
    if (!await this.exists(binary)) throw new Error('ไม่พบ Silero VAD runner');
    const args = ['--file', wav, '--vad-model', this.vadModel, '--vad-threshold', '0.50', '--vad-min-speech-duration-ms', '120', '--vad-min-silence-duration-ms', '180', '--vad-max-speech-duration-s', '30', '--vad-speech-pad-ms', '80', '--vad-samples-overlap', '0.10', '--no-prints'];
    const output = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: this.root, windowsHide: true, signal });
      let text = '';
      child.stdout.on('data', data => { text += String(data); });
      child.stderr.on('data', data => { text += String(data); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(text) : reject(new Error(text.slice(-1500) || `VAD exited ${code}`)));
    });
    return parseVadSpeechRegions(output);
  }

  status() {
    return { mode: this.mode, requestedProfile: this.requestedProfile, activeProfile: this.activeProfile, fallback: this.fallback, running: Boolean(this.child) };
  }

  async stop() {
    if (this.child && !this.child.killed) {
      this.child.kill();
      for (let index = 0; index < 20 && this.child; index++) await wait(100);
      if (this.child) this.child.kill('SIGKILL');
    }
    this.child = null;
  }

  async cancel() { await this.stop(); }
}

export function extractTimedTokens(result) {
  const tokens = [];
  for (const segment of result.segments || result.transcription || []) {
    const text = String(segment.text || '').trim(), noSpeech = Number(segment.no_speech_prob ?? 0), logprob = Number(segment.avg_logprob ?? 0);
    if ((noSpeech > .5 && logprob < -.25) || /^[\[(].*(music|noise|silence|applause|ดนตรี|เสียงรบกวน).*[\])]$/i.test(text)) continue;
    if (Array.isArray(segment.words) && segment.words.length) {
      const confidences = segment.words.map(word => word.probability).filter(Number.isFinite);
      if (confidences.length && confidences.reduce((a, b) => a + b, 0) / confidences.length < .35) continue;
      let first = true;
      for (const word of segment.words) {
        const start = Number(word.start), end = Number(word.end);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          tokens.push({ text: word.word ?? word.text, start, end, rawConfidence: word.probability ?? null, confidence: word.probability ?? null, segmentLogprob: logprob, noSpeechProbability: noSpeech, segmentBreak: first && tokens.length > 0 });
          first = false;
        }
      }
    } else if (Array.isArray(segment.tokens) && segment.tokens.length && typeof segment.tokens[0] === 'object') {
      let first = true;
      for (const token of segment.tokens) {
        const start = Number(token.t0 ?? token.start ?? token.offsets?.from) / (token.t0 != null ? 100 : token.offsets?.from != null ? 1000 : 1);
        const end = Number(token.t1 ?? token.end ?? token.offsets?.to) / (token.t1 != null ? 100 : token.offsets?.to != null ? 1000 : 1);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          const raw = token.p ?? token.probability ?? null;
          tokens.push({ text: token.text ?? token.token, start, end, rawConfidence: raw, confidence: raw, segmentLogprob: logprob, noSpeechProbability: noSpeech, segmentBreak: first && tokens.length > 0 });
          first = false;
        }
      }
    } else {
      const start = Number(segment.start ?? segment.offsets?.from / 1000 ?? 0), end = Number(segment.end ?? segment.offsets?.to / 1000 ?? start + .2);
      if (segment.text?.trim()) {
        const raw = segment.avg_logprob == null ? null : Math.exp(segment.avg_logprob);
        tokens.push({ text: segment.text, start, end, rawConfidence: raw, confidence: raw, segmentLogprob: logprob, noSpeechProbability: noSpeech, segmentBreak: tokens.length > 0 });
      }
    }
  }
  return tokens;
}

export function extractSpeechRegions(result, { padding = .08 } = {}) {
  const regions = [];
  for (const [index, segment] of (result.segments || result.transcription || []).entries()) {
    const noSpeech = Number(segment.no_speech_prob ?? 0), logprob = Number(segment.avg_logprob ?? 0);
    if (noSpeech > .5 && logprob < -.25) continue;
    const start = Number(segment.start ?? segment.offsets?.from / 1000), end = Number(segment.end ?? segment.offsets?.to / 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const next = { id: `speech-${index}`, start: Math.max(0, start - padding), end: end + padding };
    const previous = regions.at(-1);
    if (previous && next.start <= previous.end + .06) previous.end = Math.max(previous.end, next.end);
    else regions.push(next);
  }
  return regions;
}

export function parseVadSpeechRegions(output) {
  const regions = [];
  for (const match of String(output || '').matchAll(/Speech segment\s+\d+:\s+start\s*=\s*([0-9.]+),\s+end\s*=\s*([0-9.]+)/g)) {
    const start = Number(match[1]) / 100, end = Number(match[2]) / 100;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) regions.push({ id: `speech-${regions.length}`, start, end });
  }
  return regions;
}
