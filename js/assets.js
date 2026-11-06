/**
 * 素材加载：实景扫描的 PBR 贴图 + HDRI 环境光
 *
 * 为什么要有这一层：
 * 程序化生成的贴图能表达"颜色"，表达不了"粗糙度、法线细节、真实反射"。
 * 这些只能来自实拍素材 —— 这是画质能不能立住的分水岭。
 *
 * 素材来源：Poly Haven（CC0 公共领域，可商用）
 *   aerial_grass_rock  航拍草地与碎石
 *   clay_roof_tiles_02 黏土瓦
 *   brick_4            红砖墙
 *   belfast_open_field 阴天开阔田野（HDRI）
 */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const BASE = './assets/';

/** 单文件版会把素材以 data URI 形式注入这里 */
const inline = (p) => (typeof window !== 'undefined' && window.__ASSETS && window.__ASSETS[p]) || null;

export const Assets = {
  env: null,
  grass: null,
  roof: null,
  brick: null,
  road: null,
  ready: false,

  async load(renderer) {
    const loader = new THREE.TextureLoader();

    const tex = (p, srgb) => {
      const src = inline(p);
      return new Promise((resolve, reject) => {
        loader.load(
          src || BASE + p,
          (t) => {
            if (srgb) t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = 8;
            resolve(t);
          },
          undefined,
          () => reject(new Error(`素材加载失败：${p}`))
        );
      });
    };

    const [grassD, grassN, grassR, roofD, roofN, brickD, brickN,
      roadD, roadN, roadR] = await Promise.all([
      tex('tex/grass_diffuse.jpg', true),
      tex('tex/grass_nor_gl.jpg', false),
      tex('tex/grass_rough.jpg', false),
      tex('tex/roof_diffuse.jpg', true),
      tex('tex/roof_nor_gl.jpg', false),
      tex('tex/brick_diffuse.jpg', true),
      tex('tex/brick_nor_gl.jpg', false),
      tex('tex/road_diffuse.jpg', true),
      tex('tex/road_nor_gl.jpg', false),
      tex('tex/road_rough.jpg', false),
    ]);

    const wrap = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };

    this.grass = { map: wrap(grassD), normalMap: wrap(grassN), roughnessMap: wrap(grassR) };
    this.roof = { map: wrap(roofD), normalMap: wrap(roofN) };
    this.brick = { map: wrap(brickD), normalMap: wrap(brickN) };
    this.road = { map: wrap(roadD), normalMap: wrap(roadN), roughnessMap: wrap(roadR) };

    // HDRI：真实天空的辐照度，给所有材质提供间接光与反射
    try {
      const hdrSrc = inline('hdri/field.hdr') || BASE + 'hdri/field.hdr';
      const hdr = await new RGBELoader().loadAsync(hdrSrc);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      this.env = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      pmrem.dispose();
    } catch (e) {
      console.warn('HDRI 未加载，退回程序化环境光', e.message);
    }

    this.ready = true;
    return this;
  },
};
