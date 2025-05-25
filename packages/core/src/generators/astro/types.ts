import { BaseTranspilerOptions } from '@/types/transpiler';

export interface ToAstroOptions extends BaseTranspilerOptions {
	/**
	 * Client directive to use for interactive components
	 * @default 'client:load'
	 */
	clientDirective?: 'client:load' | 'client:idle' | 'client:visible' | 'client:media' | 'none';

	/**
	 * Whether to use TypeScript in the frontmatter
	 * @default true
	 */
	typescript?: boolean;

	/**
	 * Whether to generate .astro or .ts files
	 * @default 'astro'
	 */
	outputFormat?: 'astro' | 'typescript';
}

export type AstroMetadata = {
	/**
	 * Whether this component needs client-side hydration
	 */
	needsHydration?: boolean;

	/**
	 * Client directive used for this component
	 */
	clientDirective?: string;
};