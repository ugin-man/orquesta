export const HOME_TUTORIAL_TARGET_ATTRIBUTE = 'data-orquesta-tutorial-target';

export type TutorialTargetRect = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export function tutorialTargetProps(id: string): Record<typeof HOME_TUTORIAL_TARGET_ATTRIBUTE, string> {
  return { [HOME_TUTORIAL_TARGET_ATTRIBUTE]: id };
}

export function measureTutorialTargets(root: Document, ids: readonly string[]): TutorialTargetRect[] {
  return ids.flatMap((id) => {
    const element = root.querySelector<HTMLElement>(`[${HOME_TUTORIAL_TARGET_ATTRIBUTE}="${id}"]`);
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [{ id, left: rect.left, top: rect.top, width: rect.width, height: rect.height }];
  });
}

export function findTutorialTargetElements(root: Document, ids: readonly string[]): HTMLElement[] {
  return ids.flatMap((id) => {
    const element = root.querySelector<HTMLElement>(`[${HOME_TUTORIAL_TARGET_ATTRIBUTE}="${id}"]`);
    return element ? [element] : [];
  });
}
