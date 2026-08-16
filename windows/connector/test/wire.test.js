import test from 'node:test';
import assert from 'node:assert/strict';
import { filterBluetoothPorts } from '../src/wire.js';

// Captured verbatim from SerialPort.list() on real hardware: one paired Car
// Thing surfaces two of these, with meaningfully different pnpId shapes
// (VID/PID-identified vs LOCALMFG), and either can be the one actually
// carrying live traffic — which is exactly why this filters to "candidates",
// not "the one true port".
const BT_PORT_A = {
  path: 'COM3',
  manufacturer: 'Microsoft',
  pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_VID&00021D6B_PID&0246\\8&3B9713F3&0&30E3D600F419_C00000000',
  friendlyName: 'Standard Serial over Bluetooth link (COM3)',
};
const BT_PORT_B = {
  path: 'COM4',
  manufacturer: 'Microsoft',
  pnpId: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\8&3B9713F3&0&000000000000_00000002',
  friendlyName: 'Standard Serial over Bluetooth link (COM4)',
};
const UNRELATED_PORT = {
  path: 'COM7',
  manufacturer: 'FTDI',
  pnpId: 'USB\\VID_0403&PID_6001\\A50285BI',
  friendlyName: 'USB Serial Port (COM7)',
};

test('keeps both Bluetooth SPP ports and drops an unrelated USB serial port', () => {
  const paths = filterBluetoothPorts([BT_PORT_A, BT_PORT_B, UNRELATED_PORT], 'COM4');
  assert.deepEqual(new Set(paths), new Set(['COM3', 'COM4']));
});

test('preferred path sorts first when present', () => {
  const paths = filterBluetoothPorts([BT_PORT_A, BT_PORT_B], 'COM4');
  assert.equal(paths[0], 'COM4');
});

test('falls back to every listed port when nothing looks like Bluetooth', () => {
  const paths = filterBluetoothPorts([UNRELATED_PORT], 'COM4');
  assert.deepEqual(new Set(paths), new Set(['COM4', 'COM7']));
});

test('preferred path is included even if SerialPort.list() never reported it', () => {
  const paths = filterBluetoothPorts([BT_PORT_A], 'COM9');
  assert.deepEqual(new Set(paths), new Set(['COM9', 'COM3']));
});
