export type PromptContext = {
  soulName: string;
  soulDescription: string;
  soulTone?: string | null;
  soulBoundaries?: string | null;
  soulKnowledge?: string | null;
  soulOthers?: string | null;
  soulSystemPromptOverride?: string | null;
  soulSystemPromptAppend?: string | null;
  approvedToolNames: string[];
  skillListing?: string | null;
  modelName: string;
  providerName: string;
};

export type PromptSectionDefinition = {
  name: string;
  template: string | null;
  buildTemplateVars: (context: PromptContext) => Record<string, string>;
  cachePolicy: 'stable' | 'volatile';
  boundary: 'static' | 'dynamic';
  enabledWhen?: (context: PromptContext) => boolean;
};

export type BuiltPromptSection = {
  name: string;
  template?: string;
  content: string;
  cachePolicy: 'stable' | 'volatile';
  boundary: 'static' | 'dynamic';
};

export type BuiltPrompt = {
  sections: BuiltPromptSection[];
  staticPrefix: string[];
  dynamicTail: string[];
  finalSystemPrompt: string[];
};

export interface ISystemPromptBuilder {
  build(context: PromptContext): BuiltPrompt;
  clearCache(): void;
}
