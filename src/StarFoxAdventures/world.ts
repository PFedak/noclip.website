import { mat4, vec3 } from 'gl-matrix';
import * as UI from '../ui';
import { DataFetcher } from '../DataFetcher';
import * as Viewer from '../viewer';
import { GfxDevice } from '../gfx/platform/GfxPlatform';
import { GfxRenderInstManager, GfxRenderInst } from "../gfx/render/GfxRenderer";
import { SceneContext } from '../SceneBase';
import { TDDraw } from "../SuperMarioGalaxy/DDraw";
import * as GX from '../gx/gx_enum';
import { ub_PacketParams, u_PacketParamsBufferSize, fillPacketParamsData } from "../gx/gx_render";
import { ViewerRenderInput } from "../viewer";
import { fillSceneParamsDataOnTemplate, PacketParams, GXMaterialHelperGfx, MaterialParams } from '../gx/gx_render';
import { getDebugOverlayCanvas2D, drawWorldSpaceText, drawWorldSpacePoint, drawWorldSpaceLine } from "../DebugJunk";
import { getMatrixAxisZ } from '../MathHelpers';

import { SFA_GAME_INFO, SFADEMO_GAME_INFO, GameInfo } from './scenes';
import { loadRes, ResourceCollection } from './resource';
import { ObjectManager, ObjectInstance } from './objects';
import { EnvfxManager } from './envfx';
import { SFATextureCollection } from './textures';
import { SFARenderer } from './render';
import { GXMaterialBuilder } from '../gx/GXMaterialBuilder';
import { MapInstance, loadMap } from './maps';
import { createDownloadLink, dataSubarray, interpS16, angle16ToRads } from './util';
import { ModelVersion, ModelInstance, ModelCollection } from './models';
import { MaterialFactory } from './shaders';
import { SFAAnimationController, AnimCollection, AmapCollection, ModanimCollection } from './animation';

const materialParams = new MaterialParams();
const packetParams = new PacketParams();
const atmosTextureNum = 1;

function submitScratchRenderInst(device: GfxDevice, renderInstManager: GfxRenderInstManager, materialHelper: GXMaterialHelperGfx, renderInst: GfxRenderInst, viewerInput: ViewerRenderInput, noViewMatrix: boolean = false, materialParams_ = materialParams, packetParams_ = packetParams): void {
    materialHelper.setOnRenderInst(device, renderInstManager.gfxRenderCache, renderInst);
    renderInst.setSamplerBindingsFromTextureMappings(materialParams_.m_TextureMapping);
    const offs = materialHelper.allocateMaterialParams(renderInst);
    materialHelper.fillMaterialParamsDataOnInst(renderInst, offs, materialParams_);
    renderInst.allocateUniformBuffer(ub_PacketParams, u_PacketParamsBufferSize);
    if (noViewMatrix) {
        mat4.identity(packetParams_.u_PosMtx[0]);
    } else {
        mat4.copy(packetParams_.u_PosMtx[0], viewerInput.camera.viewMatrix);
    }
    fillPacketParamsData(renderInst.mapUniformBufferF32(ub_PacketParams), renderInst.getUniformBufferOffset(ub_PacketParams), packetParams_);
    renderInstManager.submitRenderInst(renderInst);
}

function vecPitch(v: vec3): number {
    return Math.atan2(v[1], Math.hypot(v[2], v[0]));
}

async function testLoadingAModel(device: GfxDevice, animController: SFAAnimationController, dataFetcher: DataFetcher, gameInfo: GameInfo, subdir: string, modelNum: number, modelVersion?: ModelVersion): Promise<ModelInstance | null> {
    const pathBase = gameInfo.pathBase;
    const texColl = new SFATextureCollection(gameInfo, modelVersion === ModelVersion.Beta);
    const [modelsTabData, modelsBin, _] = await Promise.all([
        dataFetcher.fetchData(`${pathBase}/${subdir}/MODELS.tab`),
        dataFetcher.fetchData(`${pathBase}/${subdir}/MODELS.bin`),
        texColl.create(dataFetcher, subdir),
    ]);
    const modelsTab = modelsTabData.createDataView();

    const modelTabValue = modelsTab.getUint32(modelNum * 4);
    if (modelTabValue === 0) {
        throw Error(`Model #${modelNum} not found`);
    }

    const modelOffs = modelTabValue & 0xffffff;
    const modelData = loadRes(modelsBin.subarray(modelOffs + 0x24));
    
    window.main.downloadModel = () => {
        const aEl = createDownloadLink(modelData, `model_${subdir}_${modelNum}.bin`);
        aEl.click();
    };
    
    try {
        // return new Model(device, new MaterialFactory(device), modelData, texColl, animController, modelVersion);
        throw Error(`TODO: implement`);
    } catch (e) {
        console.warn(`Failed to load model due to exception:`);
        console.error(e);
        return null;
    }
}

class WorldRenderer extends SFARenderer {
    private ddraw = new TDDraw();
    private materialHelperSky: GXMaterialHelperGfx;

    constructor(device: GfxDevice, animController: SFAAnimationController, private materialFactory: MaterialFactory, private envfxMan: EnvfxManager, private mapInstance: MapInstance | null, private objectInstances: ObjectInstance[], private models: (ModelInstance | null)[], private resColl: ResourceCollection) {
        super(device, animController);

        packetParams.clear();

        const atmos = this.envfxMan.atmosphere;
        const tex = atmos.textures[atmosTextureNum]!;
        materialParams.m_TextureMapping[0].gfxTexture = tex.gfxTexture;
        materialParams.m_TextureMapping[0].gfxSampler = tex.gfxSampler;
        materialParams.m_TextureMapping[0].width = tex.width;
        materialParams.m_TextureMapping[0].height = tex.height;
        materialParams.m_TextureMapping[0].lodBias = 0.0;
        mat4.identity(materialParams.u_TexMtx[0]);

        this.ddraw.setVtxDesc(GX.Attr.POS, true);
        this.ddraw.setVtxDesc(GX.Attr.TEX0, true);
        this.ddraw.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.POS, GX.CompCnt.POS_XYZ);
        this.ddraw.setVtxAttrFmt(GX.VtxFmt.VTXFMT0, GX.Attr.TEX0, GX.CompCnt.TEX_ST);

        let mb = new GXMaterialBuilder();
        mb.setTexCoordGen(GX.TexCoordID.TEXCOORD0, GX.TexGenType.MTX2x4, GX.TexGenSrc.TEX0, GX.TexGenMatrix.IDENTITY);
        mb.setTevDirect(0);
        mb.setTevOrder(0, GX.TexCoordID.TEXCOORD0, GX.TexMapID.TEXMAP0, GX.RasColorChannelID.COLOR_ZERO);
        mb.setTevColorIn(0, GX.CC.ZERO, GX.CC.ZERO, GX.CC.ZERO, GX.CC.TEXC);
        mb.setTevColorOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setTevAlphaIn(0, GX.CA.ZERO, GX.CA.ZERO, GX.CA.ZERO, GX.CA.TEXA);
        mb.setTevAlphaOp(0, GX.TevOp.ADD, GX.TevBias.ZERO, GX.TevScale.SCALE_1, true, GX.Register.PREV);
        mb.setBlendMode(GX.BlendMode.NONE, GX.BlendFactor.ONE, GX.BlendFactor.ZERO);
        mb.setZMode(false, GX.CompareType.ALWAYS, false);
        mb.setCullMode(GX.CullMode.NONE);
        mb.setUsePnMtxIdx(false);
        this.materialHelperSky = new GXMaterialHelperGfx(mb.finish('sky'));
    }

    // XXX: for testing
    public enableFineAnims(enable: boolean = true) {
        this.animController.enableFineSkinAnims = enable;
    }

    protected update(viewerInput: Viewer.ViewerRenderInput) {
        super.update(viewerInput);
        this.materialFactory.update(this.animController);
    }

    protected renderSky(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput) {
        this.beginPass(viewerInput, true);

        const atmos = this.envfxMan.atmosphere;
        const atmosTexture = atmos.textures[atmosTextureNum]!;

        // Extract pitch
        const cameraFwd = vec3.create();
        getMatrixAxisZ(cameraFwd, viewerInput.camera.worldMatrix);
        vec3.negate(cameraFwd, cameraFwd);
        const camPitch = vecPitch(cameraFwd);
        const camRoll = Math.PI / 2;

        // Draw atmosphere
        // FIXME: This implementation is adapted from the game, but correctness is not verified.
        // We should probably use a different technique, since this one works poorly in VR.
        // TODO: Implement time of day, which the game implements by blending gradient textures on the CPU.
        const fovRollFactor = 3.0 * (atmosTexture.height * 0.5 * viewerInput.camera.fovY / Math.PI) * Math.sin(-camRoll);
        const pitchFactor = (0.5 * atmosTexture.height - 6.0) - (3.0 * atmosTexture.height * camPitch / Math.PI);
        const t0 = (pitchFactor + fovRollFactor) / atmosTexture.height;
        const t1 = t0 - (fovRollFactor * 2.0) / atmosTexture.height;

        this.ddraw.beginDraw();
        this.ddraw.begin(GX.Command.DRAW_QUADS);
        this.ddraw.position3f32(-1, -1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t1);
        this.ddraw.position3f32(-1, 1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t0);
        this.ddraw.position3f32(1, 1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t0);
        this.ddraw.position3f32(1, -1, -1);
        this.ddraw.texCoord2f32(GX.Attr.TEX0, 1.0, t1);
        this.ddraw.end();

        const renderInst = this.ddraw.makeRenderInst(device, renderInstManager);
        submitScratchRenderInst(device, renderInstManager, this.materialHelperSky, renderInst, viewerInput, true);

        this.ddraw.endAndUpload(device, renderInstManager);
        
        this.endPass(device);
    }

    private renderTestModel(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, matrix: mat4, modelInst: ModelInstance) {
        modelInst.prepareToRender(device, renderInstManager, viewerInput, matrix, this.sceneTexture, 0);

        // Draw bones
        const drawBones = false;
        if (drawBones) {
            const ctx = getDebugOverlayCanvas2D();
            for (let i = 1; i < modelInst.model.joints.length; i++) {
                const joint = modelInst.model.joints[i];
                const jointMtx = mat4.clone(modelInst.boneMatrices[i]);
                mat4.mul(jointMtx, jointMtx, matrix);
                const jointPt = vec3.create();
                mat4.getTranslation(jointPt, jointMtx);
                if (joint.parent != 0xff) {
                    const parentMtx = mat4.clone(modelInst.boneMatrices[joint.parent]);
                    mat4.mul(parentMtx, parentMtx, matrix);
                    const parentPt = vec3.create();
                    mat4.getTranslation(parentPt, parentMtx);
                    drawWorldSpaceLine(ctx, viewerInput.camera, parentPt, jointPt);
                } else {
                    drawWorldSpacePoint(ctx, viewerInput.camera, jointPt);
                }
            }
        }
    }

    protected renderWorld(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: ViewerRenderInput) {
        // Render opaques
        this.beginPass(viewerInput);
        if (this.mapInstance !== null) {
            this.mapInstance.prepareToRender(device, renderInstManager, viewerInput, this.sceneTexture, 0);
        }
        
        const mtx = mat4.create();
        const ctx = getDebugOverlayCanvas2D();
        for (let i = 0; i < this.objectInstances.length; i++) {
            const obj = this.objectInstances[i];

            obj.render(device, renderInstManager, viewerInput, this.sceneTexture, 0);
            // TODO: additional draw steps; object furs and translucents

            const drawLabels = false;
            if (drawLabels) {
                drawWorldSpaceText(ctx, viewerInput.camera, obj.getPosition(), obj.getName(), undefined, undefined, {outline: 2});
            }
        }
        
        const testCols = Math.ceil(Math.sqrt(this.models.length));
        let col = 0;
        let row = 0;
        for (let i = 0; i < this.models.length; i++) {
            if (this.models[i] !== null) {
                mat4.fromTranslation(mtx, [col * 60, row * 60, 0]);
                this.renderTestModel(device, renderInstManager, viewerInput, mtx, this.models[i]!);
                col++;
                if (col >= testCols) {
                    col = 0;
                    row++;
                }
            }
        }
        
        this.endPass(device);

        // Render waters, furs and translucents
        this.beginPass(viewerInput);
        if (this.mapInstance !== null) {
            this.mapInstance.prepareToRenderWaters(device, renderInstManager, viewerInput, this.sceneTexture);
            this.mapInstance.prepareToRenderFurs(device, renderInstManager, viewerInput, this.sceneTexture);
        }
        this.endPass(device);

        const NUM_DRAW_STEPS = 3;
        for (let drawStep = 1; drawStep < NUM_DRAW_STEPS; drawStep++) {
            this.beginPass(viewerInput);
            if (this.mapInstance !== null) {
                this.mapInstance.prepareToRender(device, renderInstManager, viewerInput, this.sceneTexture, drawStep);
            }
            this.endPass(device);
        }    
    }
}

export class SFAWorldSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, private subdir: string, private mapNum: number, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for world ${this.name} (ID ${this.id}) ...`);

        const materialFactory = new MaterialFactory(device);
        const animController = new SFAAnimationController();
        const mapSceneInfo = await loadMap(device, materialFactory, animController, context, this.mapNum, this.gameInfo);
        const mapInstance = new MapInstance(mapSceneInfo);
        await mapInstance.reloadBlocks();

        // Translate map for SFA world coordinates
        const objectOrigin = vec3.fromValues(640 * mapSceneInfo.getOrigin()[0], 0, 640 * mapSceneInfo.getOrigin()[1]);
        const mapMatrix = mat4.create();
        const mapTrans = vec3.clone(objectOrigin);
        vec3.negate(mapTrans, mapTrans);
        mat4.fromTranslation(mapMatrix, mapTrans);
        mapInstance.setMatrix(mapMatrix);

        const pathBase = this.gameInfo.pathBase;
        const dataFetcher = context.dataFetcher;
        const resColl = new ResourceCollection(this.gameInfo, this.subdir, animController);
        await resColl.create(context.dataFetcher);
        const objectMan = new ObjectManager(this.gameInfo, resColl, false);
        const earlyObjectMan = new ObjectManager(SFADEMO_GAME_INFO, resColl, true);
        const envfxMan = new EnvfxManager(this.gameInfo, resColl.texColl);
        const [_1, _2, _3, romlistFile] = await Promise.all([
            objectMan.create(dataFetcher),
            earlyObjectMan.create(dataFetcher),
            envfxMan.create(dataFetcher),
            dataFetcher.fetchData(`${pathBase}/${this.id}.romlist.zlb`),
        ]);
        const romlist = loadRes(romlistFile).createDataView();

        const objectInstances: ObjectInstance[] = [];

        let offs = 0;
        let i = 0;
        while (offs < romlist.byteLength) {
            const fields = {
                objType: romlist.getUint16(offs + 0x0),
                entrySize: romlist.getUint8(offs + 0x2),
                radius: 8 * romlist.getUint8(offs + 0x6),
                pos: vec3.fromValues(
                    romlist.getFloat32(offs + 0x8),
                    romlist.getFloat32(offs + 0xc),
                    romlist.getFloat32(offs + 0x10)
                ),
            };

            const posInMap = vec3.clone(fields.pos);
            vec3.add(posInMap, posInMap, objectOrigin);

            const objParams = dataSubarray(romlist, offs, fields.entrySize * 4);

            const obj = await objectMan.createObjectInstance(device, animController, materialFactory, fields.objType, objParams, posInMap, mapInstance);
            objectInstances.push(obj);

            console.log(`Object #${i}: ${obj.getName()} (type ${obj.getType().typeNum} class ${obj.getType().objClass})`);

            offs += fields.entrySize * 4;
            i++;
        }

        window.main.lookupObject = (objType: number, skipObjindex: boolean = false) => async function() {
            const obj = await objectMan.loadObjectType(device, materialFactory, objType, skipObjindex);
            console.log(`Object ${objType}: ${obj.name} (type ${obj.typeNum} class ${obj.objClass})`);
        };

        window.main.lookupEarlyObject = (objType: number, skipObjindex: boolean = false) => async function() {
            const obj = await earlyObjectMan.loadObjectType(device, materialFactory, objType, skipObjindex);
            console.log(`Object ${objType}: ${obj.name} (type ${obj.typeNum} class ${obj.objClass})`);
        };

        const envfx = envfxMan.loadEnvfx(device, 60);
        console.log(`Envfx ${envfx.index}: ${JSON.stringify(envfx, null, '\t')}`);

        const testModels: (ModelInstance | null)[] = [];
        console.log(`Loading Fox....`);
        testModels.push(await testLoadingAModel(device, animController, dataFetcher, this.gameInfo, this.subdir, 1)); // Fox
        // console.log(`Loading SharpClaw....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, this.gameInfo, this.subdir, 23)); // Sharpclaw
        // console.log(`Loading General Scales....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, this.gameInfo, 'shipbattle', 0x140 / 4)); // General Scales
        // console.log(`Loading SharpClaw (demo version)....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFADEMO_GAME_INFO, 'warlock', 0x1394 / 4, ModelVersion.Demo)); // SharpClaw (beta version)
        // console.log(`Loading General Scales (demo version)....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFADEMO_GAME_INFO, 'shipbattle', 0x138 / 4, ModelVersion.Demo)); // General Scales (beta version)
        // console.log(`Loading Beta Fox....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFADEMO_GAME_INFO, 'swapcircle', 0x0 / 4, ModelVersion.Beta, true)); // Fox (beta version)
        // console.log(`Loading a model (really old version)....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFADEMO_GAME_INFO, 'swapcircle', 0x28 / 4, ModelVersion.Beta));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'warlock', 11, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'warlock', 14, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'warlock', 23, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'capeclaw', 26, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'capeclaw', 29, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'capeclaw', 148, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'swaphol', 212, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'swaphol', 220, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'capeclaw', 472, ModelVersion.Final));
        // console.log(`Loading a model with PNMTX 9 stuff....`);
        // testModels.push(await testLoadingAModel(device, animController, dataFetcher, SFA_GAME_INFO, 'warlock', 606, ModelVersion.Final));

        const enableMap = true;
        const enableObjects = true;
        const renderer = new WorldRenderer(device, animController, materialFactory, envfxMan, enableMap ? mapInstance : null, enableObjects ? objectInstances : [], testModels, resColl);
        console.info(`Enter main.scene.enableFineAnims() to enable more animations. However, this will be very slow.`);
        return renderer;
    }
}