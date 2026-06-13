// TypeScript mirror of the backend telemetry contract (backend/schema.json +
// profiles/*.json). Device-agnostic: harmonics and phase diffs are keyed maps.

export interface HarmonicSample {
  mag: number;
  phase: number; // rad
  i: number;
  q: number;
}

export interface FeatureFrame {
  type: "feature";
  seq: number;
  t: number; // s
  harmonics: Record<string, HarmonicSample>;
  phase_diffs: Record<string, number>; // rad
  extras: Record<string, number>;
}

export interface RawBlock {
  type: "raw";
  seq: number;
  t: number;
  sample_rate_hz: number;
  samples: number[];
}

export interface Harmonic {
  id: string;
  index: number;
  freq_hz: number;
}

export interface PhaseDiffDef {
  name: string;
  from: string;
  to: string;
  description?: string;
}

export interface RawSpec {
  sample_rate_hz: number;
  block_size: number;
  dtype: string;
  adc_bits: number;
  adc_vref: number;
  fullscale_lsb: number;
}

export interface SynthSpec {
  sweep_period_s: number;
  target_dwell_s: number;
  noise_lsb: number;
  targets: { name: string }[];
}

export interface Profile {
  id: string;
  title: string;
  device: Record<string, unknown>;
  harmonics: Harmonic[];
  phase_diffs: PhaseDiffDef[];
  extras: string[];
  raw: RawSpec;
  stream: { feature_hz: number; raw_hz: number };
  config_keys: string[];
  synth?: SynthSpec;
}

export interface RawIQBlock {
  type: "raw_iq";
  seq: number;
  t: number;
  sample_rate_hz: number;
  i: number[];
  q: number[];
}

export interface Hello {
  type: "hello";
  schema_version: string;
  profile: Profile;
}

export interface ConfigCommand {
  type: "config";
  key: string;
  value: unknown;
}

export interface ConfigAck {
  type: "config_ack";
  key: string;
  value: unknown;
  ok: boolean;
  detail: string;
}

export type ServerMessage = Hello | FeatureFrame | RawBlock | RawIQBlock | ConfigAck;
