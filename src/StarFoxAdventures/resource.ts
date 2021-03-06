import * as pako from 'pako';
import { hexzero } from '../util';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { decompress as lzoDecompress } from '../Common/Compression/LZO';

import { GameInfo } from './scenes';
import { DataFetcher } from '../DataFetcher';
import { SFATextureCollection } from './textures';
import { AnimCollection, AmapCollection, SFAAnimationController, ModanimCollection } from './animation';
import { ModelCollection } from './models';

class ZLBHeader {
    public static readonly SIZE = 16;

    public magic: number;
    public unk4: number;
    public unk8: number;
    public size: number;

    constructor(dv: DataView) {
        this.magic = dv.getUint32(0x0);
        this.unk4 = dv.getUint32(0x4);
        this.unk8 = dv.getUint32(0x8);
        this.size = dv.getUint32(0xC);
    }
}

function stringToFourCC(s: string): number {
    return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)
}

function loadZLB(compData: ArrayBufferSlice): ArrayBuffer {
    const dv = compData.createDataView();
    const header = new ZLBHeader(dv);

    if (header.magic != stringToFourCC('ZLB\0')) {
        throw Error(`Invalid magic identifier 0x${hexzero(header.magic, 8)}`);
    }

    return pako.inflate(new Uint8Array(compData.copyToBuffer(ZLBHeader.SIZE, header.size))).buffer;
}

function loadDIRn(data: ArrayBufferSlice): ArrayBuffer {
    const dv = data.createDataView();
    const size = dv.getUint32(8);
    return data.copyToBuffer(0x20, size);
}

function loadLZOn(data: ArrayBufferSlice, srcOffs: number): ArrayBuffer {
    const dv = data.createDataView();
    const uncompSize = dv.getUint32(srcOffs + 0x8)
    srcOffs += 0x10
    return lzoDecompress(data.slice(srcOffs), uncompSize).arrayBuffer;
}

export function loadRes(data: ArrayBufferSlice): ArrayBufferSlice {
    const dv = data.createDataView();
    const magic = dv.getUint32(0);
    switch (magic) {
    case stringToFourCC('ZLB\0'):
        return new ArrayBufferSlice(loadZLB(data));
    case stringToFourCC('DIRn'): // FIXME: actually just "DIR" is checked
        return new ArrayBufferSlice(loadDIRn(data));
    case stringToFourCC('LZOn'):
        // LZO occurs in the demo only.
        return new ArrayBufferSlice(loadLZOn(data, 0));
    default:
        console.warn(`Invalid magic identifier 0x${hexzero(magic, 8)}`);
        return data;
    }
}

export function getSubdir(locationNum: number, gameInfo: GameInfo): string {
    if (gameInfo.subdirs[locationNum] === undefined) {
        throw Error(`Subdirectory for location ${locationNum} unknown`);
    }
    return gameInfo.subdirs[locationNum];
}

export class ResourceCollection {
    public texColl: SFATextureCollection;
    public modelColl: ModelCollection;
    public animColl: AnimCollection;
    public amapColl: AmapCollection;
    public modanimColl: ModanimCollection;
    public tablesTab: DataView;
    public tablesBin: DataView;

    constructor(private gameInfo: GameInfo, private subdir: string, private animController: SFAAnimationController) {
        this.texColl = new SFATextureCollection(gameInfo, false); // TODO: support isBeta
        this.modelColl = new ModelCollection(this.texColl, this.animController, this.gameInfo)
        this.animColl = new AnimCollection(this.gameInfo);
        this.amapColl = new AmapCollection(this.gameInfo);
        this.modanimColl = new ModanimCollection(this.gameInfo);
    }

    public async create(dataFetcher: DataFetcher) {
        const pathBase = this.gameInfo.pathBase;
        await Promise.all([
            this.texColl.create(dataFetcher, this.subdir),
            this.modelColl.create(dataFetcher, this.subdir),
            this.animColl.create(dataFetcher, this.subdir),
            this.amapColl.create(dataFetcher),
            this.modanimColl.create(dataFetcher),
        ]);
        const [tablesTab, tablesBin] = await Promise.all([
            dataFetcher.fetchData(`${pathBase}/TABLES.tab`),
            dataFetcher.fetchData(`${pathBase}/TABLES.bin`),
        ]);
        this.tablesTab = tablesTab.createDataView();
        this.tablesBin = tablesBin.createDataView();
    }
}
