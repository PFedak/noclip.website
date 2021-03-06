import { mat4, vec3 } from 'gl-matrix';
import * as UI from '../ui';
import * as Viewer from "../viewer";
import { GfxDevice } from '../gfx/platform/GfxPlatform';
import { GfxRenderInstManager } from "../gfx/render/GfxRenderer";
import { SceneContext } from '../SceneBase';

import { GameInfo, SFA_GAME_INFO } from './scenes';
import { Anim, SFAAnimationController, AnimCollection, AmapCollection, interpolateKeyframes } from './animation';
import { SFARenderer } from './render';
import { ModelCollection, ModelInstance } from './models';
import { MaterialFactory } from './shaders';
import { getDebugOverlayCanvas2D, drawWorldSpaceLine, drawWorldSpacePoint } from '../DebugJunk';
import { SFATextureCollection, SFATexture } from './textures';

class ModelExhibitRenderer extends SFARenderer {
    private modelInst: ModelInstance | null | undefined = undefined; // null: Failed to load. undefined: Not set.
    private modelNum = 1;
    private modelSelect: UI.TextEntry;

    private amap: DataView | undefined = undefined;
    private anim: Anim | null | undefined = undefined;
    private animNum = 0;
    private animSelect: UI.TextEntry;

    private displayBones: boolean = false;

    constructor(device: GfxDevice, animController: SFAAnimationController, private materialFactory: MaterialFactory, private texColl: SFATextureCollection, private modelColl: ModelCollection, private animColl: AnimCollection, private amapColl: AmapCollection) {
        super(device, animController);
    }

    public createPanels(): UI.Panel[] {
        const panel = new UI.Panel();

        panel.setTitle(UI.SAND_CLOCK_ICON, 'Model Exhibit');

        this.modelSelect = new UI.TextEntry();
        this.modelSelect.ontext = (s: string) => {
            const newNum = Number.parseInt(s);
            if (newNum !== NaN) {
                this.modelNum = newNum;
                this.modelInst = undefined;
            }
        };
        //this.modelSelect.setLabel("Model #");
        //this.modelSelect.setRange(0, 200 /*this.modelColl.getNumModels()*/);
        panel.contents.append(this.modelSelect.elem);

        this.animSelect = new UI.TextEntry();
        this.animSelect.ontext = (s: string) => {
            const newNum = Number.parseInt(s);
            if (newNum !== NaN) {
                this.animNum = newNum;
                this.anim = undefined;
            }
        }
        // this.animSelect.setLabel("Animation #");
        // this.animSelect.setRange(0, 200 /*this.animLoader.getNumAnims()*/);
        panel.contents.append(this.animSelect.elem);

        const bonesSelect = new UI.Checkbox("Display Bones", false);
        bonesSelect.onchanged = () => {
            this.displayBones = bonesSelect.checked;
        };
        panel.contents.append(bonesSelect.elem);

        return [panel];
    }
    
    protected update(viewerInput: Viewer.ViewerRenderInput) {
        super.update(viewerInput);
        this.materialFactory.update(this.animController);
    }
    
    protected renderWorld(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        // if (this.modelNum !== selectedModelNum) {
        //     this.modelNum = selectedModelNum;
        //     this.model = undefined;
        // }

        if (this.modelInst === undefined) {
            try {
                this.amap = this.amapColl.getAmap(this.modelNum);
                this.modelInst = this.modelColl.createModelInstance(device, this.materialFactory, this.modelNum);
                console.log(`Loaded model ${this.modelNum}`);
            } catch (e) {
                console.warn(`Failed to load model ${this.modelNum} due to exception:`);
                console.error(e);
                this.modelInst = null;
            }
        }
        
        const animate = true;
        if (animate && this.modelInst !== null && this.modelInst !== undefined) {
            // const selectedAnimNum = this.animSelect.getValue()|0;
            // if (this.animNum !== selectedAnimNum) {
            //     this.animNum = selectedAnimNum;
            //     this.anim = null;
            // }

            if (this.anim === undefined) {
                try {
                    this.anim = this.animColl.getAnim(this.animNum);
                    console.log(`Loaded anim ${this.animNum}`);
                } catch (e) {
                    console.warn(`Failed to load animation ${this.animNum} due to exception:`);
                    console.error(e);
                    this.anim = null;
                }
            }

            if (this.anim !== null && this.anim !== undefined) {
                this.modelInst.resetPose();
                const kfTime = (this.animController.animController.getTimeInSeconds() * 8) % this.anim.keyframes.length;
                const kf0Num = Math.floor(kfTime);
                let kf1Num = kf0Num + 1;
                if (kf1Num >= this.anim.keyframes.length) {
                    kf1Num = 0;
                }
                const kf0 = this.anim.keyframes[kf0Num];
                const kf1 = this.anim.keyframes[kf1Num];
                const ratio = kfTime - kf0Num;
                const kf = interpolateKeyframes(kf0, kf1, ratio);
                for (let i = 0; i < kf.poses.length && i < this.modelInst.model.joints.length; i++) {
                    const pose = kf.poses[i];
                    const poseMtx = mat4.create();
                    mat4.fromTranslation(poseMtx, [pose.axes[0].translation, pose.axes[1].translation, pose.axes[2].translation]);
                    mat4.scale(poseMtx, poseMtx, [pose.axes[0].scale, pose.axes[1].scale, pose.axes[2].scale]);
                    mat4.rotateZ(poseMtx, poseMtx, pose.axes[2].rotation);
                    mat4.rotateY(poseMtx, poseMtx, pose.axes[1].rotation);
                    mat4.rotateX(poseMtx, poseMtx, pose.axes[0].rotation);
    
                    const jointNum = this.amap!.getInt8(i);
                    this.modelInst.setJointPose(jointNum, poseMtx);
                }
            }
        }

        // TODO: Render background (configurable?)

        // Render opaques

        this.beginPass(viewerInput);

        if (this.modelInst !== null) {
            const mtx = mat4.create();
            this.renderModel(device, renderInstManager, viewerInput, mtx, this.modelInst);
        }

        this.endPass(device);
        // TODO: render furs and translucents
    }

    private renderModel(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, matrix: mat4, modelInst: ModelInstance) {
        modelInst.prepareToRender(device, renderInstManager, viewerInput, matrix, this.sceneTexture, 0);

        if (this.displayBones) {
            // TODO: display bones as cones instead of lines
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
}

export class SFAModelExhibitSceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string, private gameInfo: GameInfo = SFA_GAME_INFO) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        console.log(`Creating scene for character exhibit ...`);
        
        const subdir = 'swaphol'; // TODO: configurable

        const materialFactory = new MaterialFactory(device);
        const animController = new SFAAnimationController();

        const amapColl = new AmapCollection(this.gameInfo);
        const animColl = new AnimCollection(this.gameInfo);
        const texColl = new SFATextureCollection(this.gameInfo, false);
        const modelColl = new ModelCollection(texColl, animController, this.gameInfo);
        await Promise.all([
            amapColl.create(context.dataFetcher),
            animColl.create(context.dataFetcher, subdir),
            texColl.create(context.dataFetcher, subdir),
            modelColl.create(context.dataFetcher, subdir),
        ]);

        return new ModelExhibitRenderer(device, animController, materialFactory, texColl, modelColl, animColl, amapColl);
    }
}
