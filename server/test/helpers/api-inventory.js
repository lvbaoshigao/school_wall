'use strict';

// Start the actual application in an isolated subprocess and capture its Express 4 registrations.
const express = require('express');
const http = require('node:http');

if (!process.env.DATA_DIR || !process.env.JWT_SECRET || process.env.HOST !== '127.0.0.1' || process.env.PORT !== '0') {
  throw new Error('API inventory requires an isolated DATA_DIR, JWT_SECRET, and loopback on a random port');
}

const mountPaths = new WeakMap();
const originalUse = express.Router.use;
express.Router.use = function (first, ...handlers) {
  const start = this.stack.length;
  const result = originalUse.call(this, first, ...handlers);
  let arg = first;
  while (Array.isArray(arg)) arg = arg[0];
  const prefix = typeof arg === 'function' ? '/' : first;
  for (const layer of this.stack.slice(start)) mountPaths.set(layer, prefix);
  return result;
};

function join(prefix, suffix) {
  if (typeof suffix !== 'string') throw new Error('API route enumeration requires a literal path');
  return (prefix + (suffix === '/' ? '' : suffix)).replace(/\/+$/, '') || '/';
}

function listRoutes(stack, prefix = '') {
  const operations = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const path of [layer.route.path].flat()) {
        const fullPath = join(prefix, path === '*' ? '/*' : path);
        if (!/^\/(?:api(?:\/|$)|dashboard\/api(?:\/|$))/.test(fullPath)) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) operations.push({ method: method.toUpperCase(), path: fullPath });
        }
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      if (!mountPaths.has(layer)) throw new Error('Untracked Express router mount');
      for (const mount of [mountPaths.get(layer)].flat()) {
        const nested = join(prefix, mount);
        operations.push(...listRoutes(layer.handle.stack, nested === '/' ? '' : nested));
      }
    }
  }
  return operations;
}

const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const app = this.listeners('request')[0];
  if (typeof process.send !== 'function' || !app?._router) throw new Error('Expected a real Express app over IPC');
  this.once('listening', () => process.send({ port: this.address().port, operations: listRoutes(app._router.stack) }));
  return listen.apply(this, args);
};

require('../../index');
