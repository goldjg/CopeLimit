/**
 * Tests for the pure parseWidgetRefreshCadence function.
 *
 * These tests cover the validation contract: only the known cadence values
 * (15, 30, 60, 120, 240) are accepted; everything else maps to null.
 */
import { describe, expect, it } from 'vitest';
import { VALID_REFRESH_CADENCES, parseWidgetRefreshCadence } from '../widget-store';

describe('parseWidgetRefreshCadence', () => {
  it('returns null for null', () => {
    expect(parseWidgetRefreshCadence(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseWidgetRefreshCadence(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseWidgetRefreshCadence('')).toBeNull();
  });

  it('returns null for the string "manual"', () => {
    expect(parseWidgetRefreshCadence('manual')).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(parseWidgetRefreshCadence(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(parseWidgetRefreshCadence(Infinity)).toBeNull();
  });

  it('returns null for -Infinity', () => {
    expect(parseWidgetRefreshCadence(-Infinity)).toBeNull();
  });

  it('returns null for an object', () => {
    expect(parseWidgetRefreshCadence({ minutes: 30 })).toBeNull();
  });

  it('returns null for an array', () => {
    expect(parseWidgetRefreshCadence([30])).toBeNull();
  });

  it('returns null for a boolean', () => {
    expect(parseWidgetRefreshCadence(true)).toBeNull();
  });

  it('returns null for an arbitrary invalid number', () => {
    expect(parseWidgetRefreshCadence(45)).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parseWidgetRefreshCadence(0)).toBeNull();
  });

  it('returns null for a negative number', () => {
    expect(parseWidgetRefreshCadence(-15)).toBeNull();
  });

  it('returns null for an unrecognised string number', () => {
    expect(parseWidgetRefreshCadence('45')).toBeNull();
  });

  it('does not accept arbitrary minute values', () => {
    const arbitrary = [1, 5, 10, 20, 45, 90, 180, 360, 480, 720, 1440];
    for (const v of arbitrary) {
      expect(parseWidgetRefreshCadence(v)).toBeNull();
    }
  });

  it.each(VALID_REFRESH_CADENCES)('accepts the numeric value %d', (minutes) => {
    expect(parseWidgetRefreshCadence(minutes)).toBe(minutes);
  });

  it.each(VALID_REFRESH_CADENCES)('accepts the string form of %d', (minutes) => {
    expect(parseWidgetRefreshCadence(String(minutes))).toBe(minutes);
  });

  it('rounds decimal values to the nearest integer before validation', () => {
    // 29.7 rounds to 30, which is valid
    expect(parseWidgetRefreshCadence(29.7)).toBe(30);
    // 15.4 rounds to 15, which is valid
    expect(parseWidgetRefreshCadence(15.4)).toBe(15);
    // 45.1 rounds to 45, which is not a valid cadence
    expect(parseWidgetRefreshCadence(45.1)).toBeNull();
  });

  it('does not throw on any input', () => {
    const inputs = [null, undefined, '', 'manual', NaN, Infinity, {}, [], true, 0, -1, 15, 30, 'garbage'];
    for (const input of inputs) {
      expect(() => parseWidgetRefreshCadence(input)).not.toThrow();
    }
  });

  it('default (null) represents manual / let iOS decide', () => {
    // Ensures the canonical default is null (no preference stored)
    expect(parseWidgetRefreshCadence(null)).toBeNull();
    expect(parseWidgetRefreshCadence(undefined)).toBeNull();
    expect(parseWidgetRefreshCadence('manual')).toBeNull();
  });
});
