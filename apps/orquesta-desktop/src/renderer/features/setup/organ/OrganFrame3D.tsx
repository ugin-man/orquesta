import { SCENE_COLORS } from './materials';
import { OutlinedBox, OutlinedRod, OutlinedTube } from './ScenePrimitives';
import type { Vec3Tuple } from './sceneLayout';

const rearFill = SCENE_COLORS.rearGraySoft;
const rearEdge = SCENE_COLORS.rearGray;
const caseFill = SCENE_COLORS.paperBright;
const caseEdge = SCENE_COLORS.graphiteSoft;

function Beam({
  size,
  position,
  opacity = 0.035,
  edgeOpacity = 0.3,
  fillColor = rearFill,
  edgeColor = rearEdge,
}: {
  size: Vec3Tuple;
  position: Vec3Tuple;
  opacity?: number;
  edgeOpacity?: number;
  fillColor?: string;
  edgeColor?: string;
}) {
  return (
    <OutlinedBox
      size={size}
      position={position}
      fillColor={fillColor}
      edgeColor={edgeColor}
      opacity={opacity}
      edgeOpacity={edgeOpacity}
    />
  );
}

const rearColumns = [-5.35, -3.55, -1.5, 1.5, 3.55, 5.35];

export function OrganFrame3D() {
  return (
    <group>
      <group position={[0, 0, -1.72]}>
        <Beam size={[12.25, 0.3, 0.34]} position={[0, -2.86, 0]} opacity={0.034} edgeOpacity={0.3} />
        <Beam size={[11.65, 0.18, 0.24]} position={[0, -2.48, 0]} opacity={0.028} edgeOpacity={0.26} />
        {rearColumns.map((x, index) => (
          <Beam
            key={x}
            size={[index === 2 || index === 3 ? 0.24 : 0.18, 7.4 + (index % 2) * 0.9, 0.23]}
            position={[x, 0.45 + (index % 2) * 0.3, 0]}
            opacity={0.025}
            edgeOpacity={0.24}
          />
        ))}
        {[-4.45, -2.7, -0.85, 0.85, 2.7, 4.45].map((x, index) => (
          <Beam
            key={`lattice-${x}`}
            size={[0.085, 3.8 + (index % 3) * 0.65, 0.13]}
            position={[x, -0.15 + (index % 2) * 0.25, -0.08]}
            opacity={0.02}
            edgeOpacity={0.2}
          />
        ))}
      </group>

      <group position={[0, 0.25, -0.52]}>
        <Beam size={[2.6, 6.4, 0.08]} position={[-4.05, 1.05, 0]} opacity={0.17} edgeOpacity={0.34} fillColor={SCENE_COLORS.graphiteSoft} edgeColor={SCENE_COLORS.rearGray} />
        <Beam size={[4.2, 7.15, 0.08]} position={[0, 1.45, 0]} opacity={0.19} edgeOpacity={0.38} fillColor={SCENE_COLORS.graphiteSoft} edgeColor={SCENE_COLORS.rearGray} />
        <Beam size={[2.6, 6.4, 0.08]} position={[4.05, 1.05, 0]} opacity={0.17} edgeOpacity={0.34} fillColor={SCENE_COLORS.graphiteSoft} edgeColor={SCENE_COLORS.rearGray} />
      </group>

      <group position={[0, 0.04, 1.52]}>
        <Beam size={[11.45, 0.38, 0.5]} position={[0, -2.42, 0]} opacity={0.14} edgeOpacity={0.62} fillColor={caseFill} edgeColor={caseEdge} />
        <Beam size={[10.75, 0.16, 0.26]} position={[0, -2.04, 0.04]} opacity={0.11} edgeOpacity={0.48} fillColor={caseFill} edgeColor={caseEdge} />
      {[-5.12, -3.28, -1.32, 1.32, 3.28, 5.12].map((x, index) => (
          <Beam
            key={`front-column-${x}`}
            size={[
              index === 2 || index === 3 ? 0.42 : index === 0 || index === 5 ? 0.46 : 0.32,
              index === 2 || index === 3 ? 9.25 : index === 0 || index === 5 ? 7.6 : 7.0,
              index === 2 || index === 3 ? 0.48 : 0.38,
            ]}
            position={[x, index === 2 || index === 3 ? 1.58 : index === 0 || index === 5 ? 0.96 : 0.68, 0]}
            opacity={index === 2 || index === 3 ? 0.15 : 0.12}
            edgeOpacity={index === 2 || index === 3 ? 0.68 : 0.56}
            fillColor={caseFill}
            edgeColor={caseEdge}
          />
        ))}

        <Beam size={[2.4, 0.22, 0.34]} position={[-4.18, 4.35, 0.02]} opacity={0.11} edgeOpacity={0.48} fillColor={caseFill} edgeColor={caseEdge} />
        <Beam size={[2.85, 0.24, 0.36]} position={[-2.0, 5.05, 0.02]} opacity={0.12} edgeOpacity={0.52} fillColor={caseFill} edgeColor={caseEdge} />
        <Beam size={[2.85, 0.24, 0.36]} position={[2.0, 5.05, 0.02]} opacity={0.12} edgeOpacity={0.52} fillColor={caseFill} edgeColor={caseEdge} />
        <Beam size={[2.4, 0.22, 0.34]} position={[4.18, 4.35, 0.02]} opacity={0.11} edgeOpacity={0.48} fillColor={caseFill} edgeColor={caseEdge} />
      </group>

      <group position={[0, 0.08, 1.46]}>
        <OutlinedTube
          points={[[-5.12, 4.62, 0], [-4.45, 5.4, 0], [-3.28, 4.15, 0]]}
          radius={0.16}
          fillColor={caseFill}
          edgeColor={caseEdge}
          opacity={0.13}
          edgeOpacity={0.6}
        />
        <OutlinedTube
          points={[[-3.28, 4.15, 0], [-2.5, 6.45, 0], [-1.32, 6.9, 0]]}
          radius={0.18}
          fillColor={caseFill}
          edgeColor={caseEdge}
          opacity={0.14}
          edgeOpacity={0.62}
        />
        <OutlinedTube
          points={[[-1.32, 6.9, 0], [-0.72, 8.15, 0], [0, 8.72, 0], [0.72, 8.15, 0], [1.32, 6.9, 0]]}
          radius={0.2}
          fillColor={caseFill}
          edgeColor={caseEdge}
          opacity={0.15}
          edgeOpacity={0.66}
        />
        <OutlinedTube
          points={[[1.32, 6.9, 0], [2.5, 6.45, 0], [3.28, 4.15, 0]]}
          radius={0.18}
          fillColor={caseFill}
          edgeColor={caseEdge}
          opacity={0.14}
          edgeOpacity={0.62}
        />
        <OutlinedTube
          points={[[3.28, 4.15, 0], [4.45, 5.4, 0], [5.12, 4.62, 0]]}
          radius={0.16}
          fillColor={caseFill}
          edgeColor={caseEdge}
          opacity={0.13}
          edgeOpacity={0.6}
        />

      </group>
      <group position={[0, -1.02, 2.75]} rotation={[-0.11, 0, 0]}>
        <Beam
          size={[2.75, 0.82, 0.34]}
          position={[0, 0, 0]}
          opacity={0.16}
          edgeOpacity={0.62}
          fillColor={caseFill}
          edgeColor={SCENE_COLORS.graphite}
        />
        <Beam
          size={[2.05, 0.14, 0.09]}
          position={[0, 0.12, 0.18]}
          opacity={0.22}
          edgeOpacity={0.66}
          fillColor={SCENE_COLORS.graphiteSoft}
          edgeColor={SCENE_COLORS.graphite}
        />
        {[-0.58, -0.29, 0, 0.29, 0.58].map((x) => (
          <Beam
            key={`console-key-${x}`}
            size={[0.18, 0.08, 0.12]}
            position={[x, -0.14, 0.18]}
            opacity={0.16}
            edgeOpacity={0.52}
            fillColor={caseFill}
            edgeColor={SCENE_COLORS.graphiteSoft}
          />
        ))}
      </group>

      {[-5.12, -3.28, -1.32, 1.32, 3.28, 5.12].map((x, index) => (
        <OutlinedRod
          key={`depth-${x}`}
          start={[x, -2.42, 1.52]}
          end={[x, index === 2 || index === 3 ? 6.9 : 4.45, -1.72]}
          radius={0.055}
          fillColor={rearFill}
          edgeColor={rearEdge}
          opacity={0.03}
          edgeOpacity={0.25}
        />
      ))}
    </group>
  );
}
