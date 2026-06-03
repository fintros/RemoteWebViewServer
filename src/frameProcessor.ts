import os from "node:os";
import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";

// На Raspberry Pi 4 обычно 4 ядра. Оставляем 1 ядро системе/Node.js, остальные отдаем libvips
sharp.concurrency(Math.max(1, os.cpus().length - 1));

export type RGBA = { data: Buffer; width: number; height: number };

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer };

export type FrameOut = {
  rects: Rect[];
  isFullFrame: boolean;
  encoding: Encoding;
};

export type FrameProcessorCfg = {
  tileSize: number;
  fullframeTileCount: number;
  fullframeAreaThreshold: number;
  jpegQuality: number;
  fullFrameEvery: number;
  maxBytesPerMessage: number;
};

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  // Храним полный буфер предыдущего кадра для сверхбыстрого сравнения в памяти
  private _prevData?: Buffer; 
  private _iter = 0;
  private _fullFrameRequested = false;

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
  }

  public async processFrameAsync(rgba: RGBA): Promise<FrameOut> {
    if (!this._prevData) {
      this._cols = Math.ceil(rgba.width / this._cfg.tileSize);
      this._rows = Math.ceil(rgba.height / this._cfg.tileSize);
    }

    let forceFull = (this._iter % this._cfg.fullFrameEvery) === 0;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    }
    const chosenEncoding: Encoding = Encoding.JPEG;

    type TileInfo = { x: number; y: number; w: number; h: number; idx: number; changed: boolean };
    const tiles: TileInfo[] = [];
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tileSize;
        const y = ty * this._cfg.tileSize;
        const w = Math.min(this._cfg.tileSize, rgba.width - x);
        const h = Math.min(this._cfg.tileSize, rgba.height - y);

        const idx = ty * this._cols + tx;
        
        // Быстрая проверка изменений в памяти без копирования и хеширования
        const changed = forceFull || this._isTileChanged(rgba.data, this._prevData, rgba.width, x, y, w, h);

        tiles.push({ x, y, w, h, idx, changed });
        if (changed) changedArea += w * h;
      }
    }

    const totalArea = rgba.width * rgba.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);

    let out: FrameOut;
    if (doFull) {
      out = await this._processFullFrame(rgba, chosenEncoding);
    } else {
      out = await this._processPartialFrame(rgba, tiles, chosenEncoding);
    }

    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    for (let i = 0; i < out.rects.length; i++) {
      const r = out.rects[i];
      if (r.data.length > maxBytesPerTile) {
        const redData = await this._makeRedFrameAsync(r.w, r.h, chosenEncoding);
        out.rects[i] = { x: r.x, y: r.y, w: r.w, h: r.h, data: redData };
      }
    }

    // Сохраняем копию текущего кадра для следующей итерации (работает мгновенно на уровне C++)
    this._prevData = Buffer.from(rgba.data);
    this._iter++;
    
    return out;
  }

  // Сверхбыстрое O(1) сравнение пикселей с использованием V8 Buffer.compare
  private _isTileChanged(cur: Buffer, prev: Buffer | undefined, frameW: number, x: number, y: number, w: number, h: number): boolean {
    if (!prev) return true;
    for (let yy = 0; yy < h; yy++) {
      const offset = ((y + yy) * frameW + x) * 4;
      const rowLen = w * 4;
      // subarray() не копирует данные, а создает view (указатель). compare() выполняется на C++
      if (cur.subarray(offset, offset + rowLen).compare(prev.subarray(offset, offset + rowLen)) !== 0) {
        return true;
      }
    }
    return false;
  }

  private async _processFullFrame(rgba: RGBA, encoding: Encoding): Promise<FrameOut> {
    const rectsForFull = this._splitWholeFrame(rgba.width, rgba.height, this._cfg.fullframeTileCount);
    
    // Выполняем кодирование тайлов ПАРАЛЛЕЛЬНО, утилизируя все ядра RPi
    const rects = await Promise.all(rectsForFull.map(async (r) => {
      const data = await this._encode(rgba, r.x, r.y, r.w, r.h, encoding);
      return { x: r.x, y: r.y, w: r.w, h: r.h, data };
    }));

    return { rects, isFullFrame: true, encoding };
  }

  private async _processPartialFrame(
    rgba: RGBA,
    tiles: { x: number; y: number; w: number; h: number; idx: number; changed: boolean }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    const mergedRects = this._mergeChangedTiles(tiles, rgba.width, rgba.height);

    // Выполняем кодирование измененных зон ПАРАЛЛЕЛЬНО
    const outRects = await Promise.all(mergedRects.map(async (r) => {
      const data = await this._encode(rgba, r.x, r.y, r.w, r.h, encoding);
      return { ...r, data };
    }));

    return { rects: outRects, isFullFrame: false, encoding };
  }

  // Единая точка входа для кодирования (Sharp берет на себя обрезку без аллокации JS буферов)
  private async _encode(rgba: RGBA, x: number, y: number, w: number, h: number, enc: Encoding): Promise<Buffer> {
    if (enc === Encoding.RAW565) {
      return this._encodeRAW565(rgba, x, y, w, h);
    }
    return this._encodeJPEG(rgba, x, y, w, h);
  }

  private async _encodeJPEG(rgba: RGBA, x: number, y: number, w: number, h: number): Promise<Buffer> {
    return sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
      .extract({ left: x, top: y, width: w, height: h }) // Обрезка на стороне libvips (С++)
      .jpeg({ 
        quality: this._cfg.jpegQuality, 
        mozjpeg: false, // Обязательно false для Raspberry Pi (ускоряет x2-x3)
        chromaSubsampling: "4:2:0" 
      })
      .toBuffer();
  }

  private _encodeRAW565(rgba: RGBA, x: number, y: number, w: number, h: number): Buffer {
    const out = Buffer.allocUnsafe(w * h * 2);
    // Для RAW-формата извлекаем и конвертируем напрямую из большого буфера
    for (let yy = 0; yy < h; yy++) {
      const srcRowOffset = ((y + yy) * rgba.width + x) * 4;
      const dstRowOffset = yy * w * 2;
      for (let xx = 0; xx < w; xx++) {
        const srcIdx = srcRowOffset + xx * 4;
        const dstIdx = dstRowOffset + xx * 2;
        const r = rgba.data[srcIdx];
        const g = rgba.data[srcIdx + 1];
        const b = rgba.data[srcIdx + 2];
        const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
        out[dstIdx] = v & 0xFF;
        out[dstIdx + 1] = (v >> 8) & 0xFF;
      }
    }
    return out;
  }

  private async _makeRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const raw = Buffer.allocUnsafe(w * h * 4);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const RGBA_RED = 0xFF0000FF; // bytes: FF 00 00 FF
    for (let o = 0; o < raw.length; o += 4) view.setUint32(o, RGBA_RED, true);
    
    // Эмулируем структуру RGBA для переиспользования пайплайна
    const dummyRgba: RGBA = { data: raw, width: w, height: h };
    return this._encode(dummyRgba, 0, 0, w, h, enc);
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    if (n === 2) {
      const h1 = Math.floor(h / 2);
      const h2 = h - h1;
      return [
        { x: 0, y: 0, w, h: h1 },
        { x: 0, y: h1, w, h: h2 },
      ];
    }

    let rows = Math.floor(Math.sqrt(n));
    while (rows > 1 && (n % rows !== 0)) rows--;
    const cols = Math.floor(n / rows);

    const split = (size: number, parts: number): number[] => {
      const out: number[] = [];
      let prev = 0;
      for (let i = 1; i <= parts; i++) {
        const cur = Math.floor((i * size) / parts);
        out.push(cur - prev);
        prev = cur;
      }
      return out;
    };

    const widths = split(w, cols);
    const heights = split(h, rows);

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let yAcc = 0;
    for (let r = 0; r < rows; r++) {
      let xAcc = 0;
      for (let c = 0; c < cols; c++) {
        rects.push({ x: xAcc, y: yAcc, w: widths[c], h: heights[r] });
        xAcc += widths[c];
      }
      yAcc += heights[r];
    }
    return rects;
  }

  private _getMaxFullTileSize(frameW: number, frameH: number): { maxW: number; maxH: number } {
    const fullRects = this._splitWholeFrame(frameW, frameH, this._cfg.fullframeTileCount);
    let maxW = 0, maxH = 0;
    for (const r of fullRects) {
      if (r.w > maxW) maxW = r.w;
      if (r.h > maxH) maxH = r.h;
    }
    return { maxW, maxH };
  }

  private _calcGridSplits(frameW: number, frameH: number) {
    const cols = this._cols, rows = this._rows, ts = this._cfg.tileSize;
    const widths: number[] = new Array(cols);
    const heights: number[] = new Array(rows);
    const xOffsets: number[] = new Array(cols);
    const yOffsets: number[] = new Array(rows);

    let x = 0;
    for (let c = 0; c < cols; c++) {
      const w = Math.min(ts, frameW - x);
      widths[c] = w;
      xOffsets[c] = x;
      x += w;
    }
    let y = 0;
    for (let r = 0; r < rows; r++) {
      const h = Math.min(ts, frameH - y);
      heights[r] = h;
      yOffsets[r] = y;
      y += h;
    }
    return { widths, heights, xOffsets, yOffsets };
  }

  private _mergeChangedTiles(
    tiles: { x: number; y: number; w: number; h: number; idx: number; changed: boolean }[],
    frameW: number,
    frameH: number
  ): { x: number; y: number; w: number; h: number }[] {
    const cols = this._cols, rows = this._rows;
    const changed: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
    const visited: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));

    for (let i = 0; i < tiles.length; i++) {
      const ty = Math.floor(i / cols);
      const tx = i % cols;
      changed[ty][tx] = tiles[i].changed;
    }

    const { widths, heights, xOffsets, yOffsets } = this._calcGridSplits(frameW, frameH);
    const { maxW, maxH } = this._getMaxFullTileSize(frameW, frameH);

    const rects: { x: number; y: number; w: number; h: number }[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!changed[r][c] || visited[r][c]) continue;

        let wTiles = 0, pxW = 0;
        while (c + wTiles < cols && changed[r][c + wTiles] && !visited[r][c + wTiles]) {
          const nextW = pxW + widths[c + wTiles];
          if (nextW > maxW) break;
          pxW = nextW;
          wTiles++;
        }

        let hTiles = 1, pxH = heights[r];
        let canGrow = true;
        while (canGrow && (r + hTiles) < rows) {
          const nextH = pxH + heights[r + hTiles];
          if (nextH > maxH) break;
          for (let cc = c; cc < c + wTiles; cc++) {
            if (!changed[r + hTiles][cc] || visited[r + hTiles][cc]) { canGrow = false; break; }
          }
          if (!canGrow) break;
          pxH = nextH;
          hTiles++;
        }

        rects.push({ x: xOffsets[c], y: yOffsets[r], w: pxW, h: pxH });

        for (let rr = r; rr < r + hTiles; rr++) {
          for (let cc = c; cc < c + wTiles; cc++) {
            visited[rr][cc] = true;
          }
        }
      }
    }

    return rects;
  }
}