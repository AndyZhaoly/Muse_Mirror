import type { ConceptItemSpec, HeroRenderPlan, LookBoardItem, OutfitCandidate } from '../types.js';

function outfitText(outfit: OutfitCandidate): string {
  return outfit.items
    .map((item) => `${item.category}: ${item.color} ${item.name}${item.fit ? `, ${item.fit}` : ''}`)
    .join('; ');
}

export function buildOutfitVisualPrompt(args: {
  outfit: OutfitCandidate;
  mode: 'flatlay' | 'moodboard' | 'mannequin';
}): string {
  const formatInstruction = args.mode === 'mannequin'
    ? 'Show a complete head-to-toe mannequin or anonymous styling figure, including face/head area, torso, legs, and shoes when those pieces exist. Do not crop at the waist unless the outfit itself is upper-body only.'
    : 'Show all key outfit pieces clearly in the selected visual format.';
  return `Create a polished fashion styling visualization in ${args.mode} format.

Outfit: ${outfitText(args.outfit)}
Styling actions: ${(args.outfit.stylingActions ?? []).join('; ') || 'none'}
Occasion: ${args.outfit.occasion ?? 'not specified'}
${formatInstruction}

Show a coherent, realistic outfit with accurate garment colors and clear separation between pieces. Do not show a recognizable real person. Do not add brand logos or pretend these are exact purchasable products. This is an AI styling concept image.`;
}

export function buildConceptItemPrompt(spec: ConceptItemSpec): string {
  return `Create a clean isolated catalog-style image of one clothing item.

Item:
- category: ${spec.subCategory || spec.category}
- color: ${spec.color}
- silhouette: ${spec.silhouette}
${spec.length ? `- length: ${spec.length}` : ''}
${spec.fit ? `- fit: ${spec.fit}` : ''}
${spec.layerRole ? `- layer role: ${spec.layerRole}` : ''}
${spec.wearMode ? `- wear mode: ${spec.wearMode}` : ''}
${spec.materialHint ? `- material appearance: ${spec.materialHint}` : ''}
${spec.requiredDetails.length ? `- required details: ${spec.requiredDetails.join('; ')}` : ''}
${spec.forbiddenDetails.length ? `- forbidden details: ${spec.forbiddenDetails.join('; ')}` : ''}

Requirements:
- item only
- centered
- full garment visible
- clean off-white or transparent background
- no model
- no mannequin
- no hanger
- no hands
- no room, furniture, or decorative scene
- no text
- no logo
- no price
- no brand marks`;
}

export function buildHeroRenderPrompt(args: {
  outfit: OutfitCandidate;
  renderPlan: HeroRenderPlan;
  items: LookBoardItem[];
  extraInstruction?: string;
}): string {
  const itemLines = args.items
    .map((item, index) => [
      `${index + 1}. ${item.slot}: ${item.color ?? ''} ${item.label} (${item.source}${item.required ? ', required' : ', optional'})`,
      item.layerRole ? `   layer role: ${item.layerRole}` : '',
      item.wearMode ? `   wear mode: ${item.wearMode}` : '',
      item.requiredDetails?.length ? `   required details: ${item.requiredDetails.join('; ')}` : '',
      item.forbiddenDetails?.length ? `   forbidden details: ${item.forbiddenDetails.join('; ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n');
  const faceInstruction =
    args.renderPlan.facePolicy === 'exclude'
      ? `Do not show a recognizable face. Use ${args.renderPlan.headTreatment.replace('_', ' ')} treatment.`
      : 'Preserve the authorized user face only if a user source photo is supplied.';
  const subjectInstruction =
    args.renderPlan.subject === 'anonymous_model'
      ? 'Use an anonymous fashion model or mannequin-like figure. This person must not resemble the user and must not be presented as the user.'
      : 'Use the authorized user source photo as the person reference. Preserve body proportions only when source framing supports it.';
  const backgroundInstruction =
    args.renderPlan.backgroundPolicy === 'replace_clean_studio'
      ? `Use a clean ${args.renderPlan.backgroundStyle ?? 'off_white_seamless'} studio background. Do not preserve bedroom, chair, curtains, mirror, office, or furniture elements.`
      : 'Preserve the source environment only if it remains clean and unobtrusive.';
  const framingContract = args.renderPlan.framingContract;
  const fullBodyInstruction = args.renderPlan.framing === 'full_body'
    ? `Full-body framing contract:
- Show one standing person from head to toe.
- Head, torso, both legs, ankles, feet, and both shoes must be completely visible.
- Leave visible floor space below the shoes and headroom above the head.
- Do not crop the head, neck, torso, legs, ankles, or footwear.
- The person should occupy between ${Math.round((framingContract?.subjectOccupancy.min ?? 0.68) * 100)}% and ${Math.round((framingContract?.subjectOccupancy.max ?? 0.82) * 100)}% of the image height.`
    : '';
  const requiredItems = args.items.filter((item) => item.required);
  const forbiddenCategories = ['hat', 'bag', 'jacket', 'coat', 'scarf']
    .filter((category) => !args.items.some((item) => item.slot === category || item.category.toLowerCase().includes(category)));
  return `Create only the hero image for a Muse Mirror Look Board.

This is NOT the complete Look Board page. Do not create side product cards, UI layout, text labels, Chinese text, prices, brand names, buttons, logos, or captions. The app will render those separately.

Subject:
- ${subjectInstruction}
- ${faceInstruction}
- framing: ${args.renderPlan.framing}
- single person only
- center the subject
- subject scale about ${args.renderPlan.composition.subjectScale}
- keep at least ${args.renderPlan.composition.minimumHeadroomPercent}% headroom and ${args.renderPlan.composition.minimumFloorMarginPercent}% floor margin
${args.renderPlan.composition.requireFeetVisible ? '- feet and shoes must be visible' : ''}
${fullBodyInstruction}

Background:
- ${backgroundInstruction}

Outfit snapshot:
${outfitText(args.outfit)}

Resolved item references supplied as images:
${itemLines || 'none'}

Use the supplied garment/item images as visual source of truth for category, main color, length, silhouette, layer relationship, wear mode, and key details.
Required outfit items that must be visible: ${requiredItems.map((item) => `${item.slot}: ${item.color ?? ''} ${item.label}`).join('; ') || 'none'}.
Do not substitute different garments.
Do not add any garment layer, outerwear, overshirt, jacket, coat, hat, bag, scarf, logo, or statement accessory unless it appears in the outfit snapshot and reference images.
Forbidden extra categories for this render: ${forbiddenCategories.join(', ') || 'none'}.
Allowed incidental details: plain socks, garment buttons, minimal neutral belt, natural seams.
${args.extraInstruction ? `User adjustment: ${args.extraInstruction}` : ''}

This is a visual styling reference, not exact sizing, material, or fit simulation.`;
}

export function buildTryOnPrompt(args: {
  outfit: OutfitCandidate;
  extraInstruction?: string;
  previewScope?: 'upper_body' | 'full_body' | 'neckline_preview' | 'upper_body_faithful' | 'full_body_synthetic';
  referenceItemCount?: number;
  isFreeformConcept?: boolean;
  limitations?: string[];
  faceMode?: 'include' | 'conceal';
  visibleItemRefs?: string[];
  notVisualizedItemRefs?: string[];
}): string {
  const scope =
    args.previewScope === 'full_body' || args.previewScope === 'full_body_synthetic'
      ? 'full-body'
      : args.previewScope === 'neckline_preview'
        ? 'neckline and shoulders'
        : 'faithful upper-body / half-body';
  const faceInstruction =
    args.faceMode === 'conceal'
      ? 'Face handling: do not show a recognizable face. Preserve the source body shape, pose, proportions, hairstyle silhouette, and overall presence, but crop above the mouth/nose, turn the face away slightly, use natural shadow, or softly de-identify facial details. Do not replace the person with a mannequin.'
      : 'Face handling: include and preserve the person face, facial features, hair, expression, and identity from the authorized source photo as much as possible.';
  const preservationInstruction =
    args.faceMode === 'conceal'
      ? 'Preserve the person body shape, body proportions, pose, camera angle, framing, skin tone where visible, hairstyle silhouette, and original environment. Only change the requested clothing and accessories.'
      : 'Preserve the person identity, face, facial features, hair, skin tone, body shape, body proportions, pose, expression, camera angle, framing, and original environment. Only change the requested clothing and accessories.';
  const scopeContract = (() => {
    if (args.previewScope === 'neckline_preview') {
      return `Scope contract: create only a neckline-and-shoulders preview. Keep the original close crop. Only adjust collar, neckline, scarf/neck accessory, outerwear shoulder area, and visible upper-chest clothing. Do not invent torso, waist, legs, shoes, or a full outfit.`;
    }
    if (args.previewScope === 'upper_body_faithful' || args.previewScope === 'upper_body') {
      return `Scope contract: create a faithful upper-body try-on. Keep the original upper-body crop, camera angle, lighting, and background. Preserve face, hair, visible skin, shoulder width, hands if visible, pose, and body proportions. Only edit clothing below the neck and within the visible upper-body area. Do not extend the frame into a full-body image. Do not claim or show pants, legs, or shoes unless they are already visible in the source photo.`;
    }
    if (args.previewScope === 'full_body_synthetic') {
      return `Scope contract: create an AI full-body concept preview using the face and visible upper body as reference. The lower body, legs, feet, pants length, shoe fit, height, and full-body proportions are synthetic guesses. Make the output clearly full-body with legs and shoes visible, but preserve the visible face, hair, skin tone, pose feeling, and upper-body identity cues as much as possible.`;
    }
    return `Scope contract: create a full-body try-on only when the source photo actually supports it. Show the full outfit, including lower body and shoes, without changing identity, body shape, or proportions.`;
  })();
  return `Using the first provided image as the authorized user photo, create a realistic ${scope} virtual styling preview of this outfit.
If additional images are provided, they are canonical garment references for the selected outfit. Use those garment reference images for garment shape, color, material cues, and category grounding instead of inventing clothing details.

${outfitText(args.outfit)}
Styling actions: ${(args.outfit.stylingActions ?? []).join('; ') || 'none'}
Occasion: ${args.outfit.occasion ?? 'not specified'}
${args.extraInstruction ? `Requested adjustment: ${args.extraInstruction}` : ''}
Reference garments provided: ${args.referenceItemCount ?? 0}
Outfit source: ${args.isFreeformConcept ? 'AI concept, not guaranteed to exist in the user closet' : 'grounded closet/outfit reference'}
Known frame limitations: ${(args.limitations ?? []).join('; ') || 'none'}
Visible item refs for this scope: ${(args.visibleItemRefs ?? []).join(', ') || 'none'}
Items not visualized in this scope: ${(args.notVisualizedItemRefs ?? []).join(', ') || 'none'}
${faceInstruction}
${scopeContract}

${preservationInstruction} Do not make the person thinner, taller, younger, older, lighter-skinned, more muscular, retouched, or sexualized. Preserve realistic fabric behavior and lighting where possible. Do not hallucinate unavailable lower-body details when the source frame does not show the lower body. This is an approximate styling preview, not an exact fit or sizing simulation.`;
}

export function buildEditTryOnPrompt(changeRequest: string): string {
  return `Edit the provided AI try-on image according to this request: ${changeRequest}

Change only what the user explicitly requested. Keep the person's identity, face, hair, skin tone, body shape, body proportions, pose, expression, camera angle, background, lighting, and all unmentioned clothing or accessories unchanged. Do not retouch or sexualize the person. Maintain a realistic camera-photo appearance.`;
}
