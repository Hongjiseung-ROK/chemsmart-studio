import type { MoleculeDocument } from '@chemsmart/studio-protocol'
import {
  AmbientLight,
  Color,
  CylinderGeometry,
  DirectionalLight,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

import { buildMoleculeScene, type MoleculeScene, pickAtom, quantizePosition, type Vec3 } from '../adapter/moleculeScene'

/**
 * The three.js binding. Owns a renderer, a camera and exactly two instanced meshes — one for
 * atoms, one for bond segments — so a structure costs two draw calls whatever its size.
 *
 * It holds no molecule state: `setDocument` rebuilds the scene from the document it is handed and
 * keeps nothing but the resulting draw instructions. There is no path from here back to the
 * document — gestures leave as callbacks carrying stable atom ids, and the caller decides what,
 * if anything, becomes a patch.
 */

/** Cylinder geometry runs along +Y, so every bond rotates from this. */
const CYLINDER_AXIS = new Vector3(0, 1, 0)
/** Enough segments to read as round at inspection distance without wasting vertices. */
const SPHERE_SEGMENTS = 24
const CYLINDER_SEGMENTS = 12
/** A pointer that travels further than this between press and release is an orbit, not a pick. */
const PICK_SLOP_PX = 4

export interface MoleculeCanvasHandlers {
  /**
   * A completed click. `atomId` is null when the click missed every atom. `additive` reports whether
   * shift or meta was held, so the caller can extend a selection rather than replace it.
   */
  onPick?: (atomId: string | null, additive: boolean, emptyPosition: Vec3 | null) => void
  /** A finished gizmo drag, carrying the quantized destination in angstrom. */
  onAtomMoved?: (atomId: string, position: Vec3) => void
}

export class MoleculeCanvas {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera: PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly transform: TransformControls
  private readonly sphereGeometry = new SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_SEGMENTS / 2)
  private readonly cylinderGeometry = new CylinderGeometry(1, 1, 1, CYLINDER_SEGMENTS)
  private readonly atomMaterial = new MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 })
  private readonly bondMaterial = new MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 })

  private atomMesh: InstancedMesh | null = null
  private bondMesh: InstancedMesh | null = null
  private current: MoleculeScene | null = null
  private frameHandle: number | null = null
  private disposed = false

  private readonly raycaster = new Raycaster()
  private readonly insertionPlane = new Plane()
  private readonly pointer = new Vector2()
  /** The empty object the gizmo drags; the atom it stands for is `gizmoAtomId`. */
  private readonly gizmoAnchor = new Object3D()
  private gizmoAtomId: string | null = null
  private pressed: { x: number; y: number } | null = null
  /**
   * Set when a gizmo drag begins, cleared at the next release. `TransformControls` registers its own
   * listeners first and clears its `dragging` flag before ours runs, so the release that ends a drag
   * would otherwise read as a stationary click on the atom underneath.
   */
  private gizmoDragged = false

  /** Scratch objects, reused so a rebuild does not allocate per instance. */
  private readonly scratchMatrix = new Matrix4()
  private readonly scratchQuaternion = new Quaternion()
  private readonly scratchColor = new Color()
  private readonly scratchFrom = new Vector3()
  private readonly scratchTo = new Vector3()
  private readonly scratchDirection = new Vector3()
  private readonly scratchPosition = new Vector3()
  private readonly scratchScale = new Vector3()

  constructor(
    canvas: HTMLCanvasElement,
    private readonly handlers: MoleculeCanvasHandlers = {}
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2))

    this.camera = new PerspectiveCamera(45, 1, 0.1, 2000)
    this.camera.position.set(0, 0, 12)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12

    this.transform = new TransformControls(this.camera, canvas)
    this.transform.enabled = false
    this.scene.add(this.gizmoAnchor)
    this.scene.add(this.transform.getHelper())
    // Orbiting while dragging an axis would fight the gesture, so the camera holds still.
    this.transform.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = !event.value
      if (event.value) this.gizmoDragged = true
    })
    // Only the release publishes. Intermediate frames would be a revision per mouse-move.
    this.transform.addEventListener('mouseUp', () => this.publishGizmoPosition())

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)

    // Two lights: a key light that follows the camera so geometry never goes flat as it turns,
    // and ambient fill so unlit faces stay readable rather than black.
    const key = new DirectionalLight(0xffffff, 2.2)
    key.position.set(1, 1, 1)
    this.camera.add(key)
    this.scene.add(this.camera)
    this.scene.add(new AmbientLight(0xffffff, 1.1))

    this.renderLoop()
  }

  /** Replaces what is drawn. Safe to call on every committed revision. */
  setDocument(document: MoleculeDocument): void {
    if (this.disposed) return
    const next = buildMoleculeScene(document)
    const shouldReframe = this.current === null
    this.current = next
    this.syncAtoms(next)
    this.syncBonds(next)
    if (shouldReframe) this.frameAll()
    // A committed revision moves atoms. The gizmo follows the atom it points at, and lets go if that
    // atom is no longer there — the committed document always wins over an in-flight gesture.
    this.setGizmoTarget(this.gizmoAtomId)
  }

  /**
   * Turns the move gizmo on. Off means picking and orbiting only, whatever is selected — the caller
   * uses this to keep the viewport read-only while a preview, a run or an approval owns the molecule.
   */
  setTransformEnabled(enabled: boolean): void {
    if (this.disposed || this.transform.enabled === enabled) return
    this.transform.enabled = enabled
    if (!enabled) this.setGizmoTarget(null)
  }

  /** Points the move gizmo at an atom, or detaches it. Unknown ids detach rather than throw. */
  setGizmoTarget(atomId: string | null): void {
    if (this.disposed) return
    const atom =
      atomId === null || !this.transform.enabled
        ? undefined
        : this.current?.atoms.find((candidate) => candidate.atomId === atomId)
    if (!atom) {
      this.gizmoAtomId = null
      this.transform.detach()
      return
    }
    this.gizmoAtomId = atom.atomId
    this.gizmoAnchor.position.set(atom.position[0], atom.position[1], atom.position[2])
    this.transform.attach(this.gizmoAnchor)
  }

  /** Points the camera at the whole structure. */
  frameAll(): void {
    if (!this.current) return
    const { center, extent } = this.current
    const target = new Vector3(center[0], center[1], center[2])
    // Back off far enough that the bounding sphere fits the vertical field of view, with headroom.
    const distance = (extent / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.6
    this.controls.target.copy(target)
    this.camera.position.copy(target).add(new Vector3(0, 0, Math.max(distance, 3)))
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  resize(width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    this.controls.dispose()
    this.transform.detach()
    this.scene.remove(this.transform.getHelper())
    this.transform.dispose()
    this.releaseMesh(this.atomMesh)
    this.releaseMesh(this.bondMesh)
    this.atomMesh = null
    this.bondMesh = null
    this.sphereGeometry.dispose()
    this.cylinderGeometry.dispose()
    this.atomMaterial.dispose()
    this.bondMaterial.dispose()
    this.renderer.dispose()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pressed = { x: event.clientX, y: event.clientY }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pressed = this.pressed
    const dragged = this.gizmoDragged
    this.pressed = null
    this.gizmoDragged = false
    if (!pressed || dragged) return
    // Anything that travelled is an orbit; only a stationary press-and-release is a pick.
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > PICK_SLOP_PX) return
    this.emitPick(event)
  }

  private emitPick(event: PointerEvent): void {
    if (!this.handlers.onPick) return
    const additive = event.shiftKey || event.metaKey
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const mesh = this.atomMesh
    const scene = this.current
    if (!mesh || !scene) {
      this.handlers.onPick(null, additive, this.emptyPickPosition())
      return
    }
    const instanceId = this.raycaster.intersectObject(mesh, false).at(0)?.instanceId
    this.handlers.onPick(
      instanceId === undefined ? null : pickAtom(scene, instanceId),
      additive,
      instanceId === undefined ? this.emptyPickPosition() : null
    )
  }

  /**
   * Projects an empty click onto the view plane through the orbit target. This is gesture intent
   * only: main still validates and journals any atom insertion derived from the coordinate.
   */
  private emptyPickPosition(): Vec3 | null {
    this.camera.getWorldDirection(this.scratchDirection)
    this.insertionPlane.setFromNormalAndCoplanarPoint(this.scratchDirection, this.controls.target)
    const point = this.raycaster.ray.intersectPlane(this.insertionPlane, this.scratchPosition)
    return point ? quantizePosition([point.x, point.y, point.z]) : null
  }

  private publishGizmoPosition(): void {
    const atomId = this.gizmoAtomId
    if (!atomId || !this.handlers.onAtomMoved) return
    const { x, y, z } = this.gizmoAnchor.position
    this.handlers.onAtomMoved(atomId, quantizePosition([x, y, z]))
  }

  private releaseMesh(mesh: InstancedMesh | null): void {
    if (!mesh) return
    this.scene.remove(mesh)
    mesh.dispose()
  }

  /**
   * `InstancedMesh` fixes its instance count at construction, so a changed atom count means a new
   * mesh. Edits happen at human speed, not per frame, so rebuilding is cheaper than the
   * bookkeeping a capacity pool would need.
   */
  private ensureMesh(
    existing: InstancedMesh | null,
    count: number,
    geometry: 'sphere' | 'cylinder'
  ): InstancedMesh | null {
    if (existing && existing.count === count) return existing
    this.releaseMesh(existing)
    if (count === 0) return null
    const mesh = new InstancedMesh(
      geometry === 'sphere' ? this.sphereGeometry : this.cylinderGeometry,
      geometry === 'sphere' ? this.atomMaterial : this.bondMaterial,
      count
    )
    mesh.frustumCulled = false
    this.scene.add(mesh)
    return mesh
  }

  private syncAtoms(scene: MoleculeScene): void {
    const mesh = this.ensureMesh(this.atomMesh, scene.atoms.length, 'sphere')
    this.atomMesh = mesh
    if (!mesh) return

    scene.atoms.forEach((atom, index) => {
      this.scratchPosition.set(atom.position[0], atom.position[1], atom.position[2])
      // A selected atom reads as a slightly larger, brighter ball — no extra draw call.
      const radius = atom.selected ? atom.radius * 1.25 : atom.radius
      this.scratchScale.setScalar(radius)
      this.scratchMatrix.compose(this.scratchPosition, new Quaternion(), this.scratchScale)
      mesh.setMatrixAt(index, this.scratchMatrix)

      this.scratchColor.setHex(atom.color)
      if (atom.selected) this.scratchColor.lerp(new Color(0xffffff), 0.45)
      mesh.setColorAt(index, this.scratchColor)
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    // Raycasting culls against this sphere before testing instances, and a reused mesh still holds
    // the bounds of the positions it had last revision.
    mesh.computeBoundingSphere()
  }

  private syncBonds(scene: MoleculeScene): void {
    const mesh = this.ensureMesh(this.bondMesh, scene.bonds.length, 'cylinder')
    this.bondMesh = mesh
    if (!mesh) return

    scene.bonds.forEach((segment, index) => {
      this.scratchFrom.set(segment.start[0], segment.start[1], segment.start[2])
      this.scratchTo.set(segment.end[0], segment.end[1], segment.end[2])
      this.scratchDirection.subVectors(this.scratchTo, this.scratchFrom)
      const length = this.scratchDirection.length()

      this.scratchPosition.addVectors(this.scratchFrom, this.scratchTo).multiplyScalar(0.5)
      this.scratchQuaternion.setFromUnitVectors(CYLINDER_AXIS, this.scratchDirection.normalize())
      this.scratchScale.set(segment.radius, length, segment.radius)
      this.scratchMatrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale)
      mesh.setMatrixAt(index, this.scratchMatrix)

      mesh.setColorAt(index, this.scratchColor.setHex(segment.color))
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  private renderLoop = (): void => {
    if (this.disposed) return
    this.frameHandle = requestAnimationFrame(this.renderLoop)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}
