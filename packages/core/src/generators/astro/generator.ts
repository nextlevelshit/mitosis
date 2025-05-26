import { babelTransformExpression } from '@/helpers/babel-transform';
import { checkIsEvent } from '@/helpers/event-handlers';
import { fastClone } from '@/helpers/fast-clone';
import { filterEmptyTextNodes } from '@/helpers/filter-empty-text-nodes';
import { getRefs } from '@/helpers/get-refs';
import { hasProps } from '@/helpers/has-props';
import { initializeOptions } from '@/helpers/merge-options';
import { getForArguments } from '@/helpers/nodes/for';
import { renderPreComponent } from '@/helpers/render-imports';
import { stripMetaProperties } from '@/helpers/strip-meta-properties';
import { collectCss } from '@/helpers/styles/collect-css';
import {
	runPostCodePlugins,
	runPostJsonPlugins,
	runPreCodePlugins,
	runPreJsonPlugins,
} from '@/modules/plugins';
import { MitosisComponent } from '@/types/mitosis-component';
import { MitosisNode, checkIsForNode } from '@/types/mitosis-node';
import { TranspilerGenerator } from '@/types/transpiler';
import { SELF_CLOSING_HTML_TAGS } from '@/constants/html_tags';
import hash from 'hash-sum';
import { kebabCase, camelCase } from 'lodash';
import { ToAstroOptions } from './types';

interface InternalToAstroOptions extends ToAstroOptions {
	component: MitosisComponent;
	cssInJs?: Map<string, string>;
	clientBoundaryComponents?: Set<string>;
}

// Astro v5 specific client directives
const CLIENT_DIRECTIVES = {
	load: 'client:load',
	idle: 'client:idle',
	visible: 'client:visible',
	media: 'client:media',
	only: 'client:only'
} as const;

// Events that require client-side hydration
const INTERACTIVE_EVENTS = new Set([
	'onClick', 'onChange', 'onInput', 'onSubmit', 'onFocus', 'onBlur',
	'onMouseOver', 'onMouseOut', 'onMouseEnter', 'onMouseLeave',
	'onKeyDown', 'onKeyUp', 'onKeyPress', 'onScroll', 'onResize',
	'onLoad', 'onError', 'onAbort', 'onCanPlay', 'onCanPlayThrough',
	'onDurationChange', 'onEmptied', 'onEnded', 'onLoadedData',
	'onLoadedMetadata', 'onLoadStart', 'onPause', 'onPlay',
	'onPlaying', 'onProgress', 'onRateChange', 'onSeeked',
	'onSeeking', 'onStalled', 'onSuspend', 'onTimeUpdate',
	'onVolumeChange', 'onWaiting', 'onWheel'
]);

/**
 * Determines if a component needs client-side hydration
 * Based on presence of refs, interactive events, or lifecycle hooks
 */
function analyzeHydrationNeeds(json: MitosisComponent): {
	needsHydration: boolean;
	reason: string[];
	suggestedDirective: string;
} {
	const reasons: string[] = [];
	let needsHydration = false;

	// Check for refs (always need client hydration)
	const refs = getRefs(json);
	if (refs.size > 0) {
		needsHydration = true;
		reasons.push(`Component uses ${refs.size} ref(s): ${Array.from(refs).join(', ')}`);
	}

	// Check for client-side lifecycle hooks
	if (json.hooks.onMount?.length > 0) {
		needsHydration = true;
		reasons.push(`Component has ${json.hooks.onMount.length} onMount hook(s)`);
	}

	if (json.hooks.onUpdate) {
		needsHydration = true;
		reasons.push(`Component has ${json.hooks.onUpdate.length} onUpdate hook(s)`);
	}

	// Check for event handlers in component tree
	let hasInteractiveEvents = false;
	function checkNodeForInteractivity(node: MitosisNode): void {
		for (const key in node.bindings) {
			if (INTERACTIVE_EVENTS.has(key)) {
				hasInteractiveEvents = true;
				reasons.push(`Found interactive event: ${key} on ${node.name}`);
				return;
			}
		}
		node.children?.forEach(checkNodeForInteractivity);
	}

	json.children?.forEach(checkNodeForInteractivity);
	if (hasInteractiveEvents) needsHydration = true;

	// Suggest appropriate directive based on usage patterns
	let suggestedDirective: any = CLIENT_DIRECTIVES.load;
	if (hasInteractiveEvents && !refs.size) {
		suggestedDirective = CLIENT_DIRECTIVES.idle; // Defer non-critical interactions
	}
	if (reasons.some(r => r.includes('onMount'))) {
		suggestedDirective = CLIENT_DIRECTIVES.load; // Mount hooks need immediate loading
	}

	return { needsHydration, reason: reasons, suggestedDirective };
}

/**
 * Enhanced class string collection for Astro v5
 * Handles static classes, dynamic bindings, and CSS-in-JS properly
 */
function collectClassString(node: MitosisNode, options: InternalToAstroOptions): string {
	const classes: string[] = [];

	// Static class properties
	if (node.properties.class?.trim()) {
		classes.push(`"${node.properties.class.trim()}"`);
	}
	if (node.properties.className?.trim()) {
		classes.push(`"${node.properties.className.trim()}"`);
	}

	// Dynamic class bindings
	if (node.bindings.class?.code?.trim()) {
		const processedCode = processBinding(node.bindings.class.code, 'template', options);
		classes.push(`(${processedCode})`);
	}
	if (node.bindings.className?.code?.trim()) {
		const processedCode = processBinding(node.bindings.className.code, 'template', options);
		classes.push(`(${processedCode})`);
	}

	// CSS-in-JS handling - convert to scoped class
	if (node.bindings.css?.code?.trim()) {
		const cssHash = hash(node.bindings.css.code);
		const scopedClassName = `${kebabCase(node.name || 'element')}-${cssHash}`;
		classes.push(`"${scopedClassName}"`);

		// Store for style generation
		if (!options.cssInJs) options.cssInJs = new Map();
		options.cssInJs.set(scopedClassName, node.bindings.css.code);
	}

	if (classes.length === 0) return '';

	// Single static class - no expression needed
	if (classes.length === 1 && classes[0].startsWith('"') && classes[0].endsWith('"')) {
		return `class=${classes[0]}`;
	}

	// Multiple or dynamic classes need expression syntax
	const classExpression = `{[${classes.join(', ')}].filter(Boolean).join(' ')}`;
	return `class=${classExpression}`;
}

/**
 * Process code bindings for different Astro contexts
 * Handles state/props references and context-specific transformations
 */
function processBinding(
	code: string,
	context: 'frontmatter' | 'template',
	options: InternalToAstroOptions
): string {
	if (!code?.trim()) return '';

	try {
		let processed = code;

		if (context === 'template') {
			// In template expressions, state and props are available as variables
			processed = processed.replace(/\bstate\.(\w+)/g, '$1');
			processed = processed.replace(/\bprops\.(\w+)/g, '$1');
		} else if (context === 'frontmatter') {
			// In frontmatter, maintain proper variable scope
			processed = processed.replace(/\bstate\.(\w+)/g, '$1');
			processed = processed.replace(/\bprops\.(\w+)/g, 'props.$1');
		}

		// Handle common transformations
		processed = babelTransformExpression(processed, {
			// Transform object property access for style objects
			ObjectExpression(path: any) {
				if (context === 'template') {
					path.node.properties?.forEach((prop: any) => {
						if (prop.key?.name && typeof prop.key.name === 'string') {
							// Convert camelCase to kebab-case for CSS properties
							const kebabKey = kebabCase(prop.key.name);
							if (kebabKey !== prop.key.name) {
								prop.key.value = kebabKey;
								prop.key.type = 'StringLiteral';
							}
						}
					});
				}
			}
		});

		return processed;
	} catch (error) {
		console.warn(`Astro: Failed to process binding "${code}":`, error);
		return code; // Fallback to original code
	}
}

/**
 * Convert CSS object syntax to CSS string
 */
function cssObjectToString(cssCode: string): string {
	try {
		// Simple CSS-in-JS object parser
		// Remove any surrounding parentheses or brackets
		const cleaned = cssCode.replace(/^\s*[\(\{]\s*|\s*[\)\}]\s*$/g, '');

		// Try to evaluate as object literal
		const cssObj = new Function(`return {${cleaned}}`)();

		let cssString = '';
		for (const [property, value] of Object.entries(cssObj)) {
			const cssProperty = kebabCase(property);
			cssString += `  ${cssProperty}: ${value};\n`;
		}

		return cssString;
	} catch (error) {
		console.warn('Could not parse CSS-in-JS object:', cssCode);
		// Fallback: try to format as-is
		return `  /* Generated from: ${cssCode} */\n`;
	}
}

/**
 * Convert individual Mitosis node to Astro template syntax
 */
function blockToAstro(node: MitosisNode, options: InternalToAstroOptions): string {
	// Handle text nodes
	if (node.properties._text) {
		return node.properties._text;
	}
	if (node.bindings._text?.code) {
		const processedCode = processBinding(node.bindings._text.code, 'template', options);
		return `{${processedCode}}`;
	}

	// Handle Fragment - render children without wrapper
	if (node.name === 'Fragment') {
		return node.children
			?.filter(filterEmptyTextNodes)
			.map(child => blockToAstro(child, options))
			.join('\n') || '';
	}

	// Handle For loops - convert to Astro map syntax
	if (checkIsForNode(node)) {
		const forArgs = getForArguments(node);
		const [itemName, indexName] = forArgs;
		const eachCode = processBinding(node.bindings.each?.code || '', 'template', options);

		const childrenContent = node.children
			?.filter(filterEmptyTextNodes)
			.map(child => blockToAstro(child, options))
			.join('\n') || '';

		return `{${eachCode}.map((${itemName}${indexName ? `, ${indexName}` : ''}) => (
      ${childrenContent}
    ))}`;
	}

	// Handle Show conditionals - convert to ternary
	if (node.name === 'Show') {
		const whenCode = processBinding(node.bindings.when?.code || '', 'template', options);
		const childrenContent = node.children
			?.filter(filterEmptyTextNodes)
			.map(child => blockToAstro(child, options))
			.join('\n') || '';

		const elseContent = node.meta?.else
			? blockToAstro(node.meta.else as MitosisNode, options)
			: 'null';

		return `{${whenCode} ? (
      ${childrenContent}
    ) : (${elseContent})}`;
	}

	// Handle regular elements
	let elementString = `<${node.name}`;

	// Handle class/className with proper collection
	const classAttr = collectClassString(node, options);
	if (classAttr) {
		elementString += ` ${classAttr}`;
	}

	// Handle static properties (excluding class/className)
	for (const [key, value] of Object.entries(node.properties)) {
		if (key === 'class' || key === 'className' || key === '_text') continue;
		elementString += ` ${key}="${value}"`;
	}

	// Handle dynamic bindings
	let needsClientDirective = false;
	for (const [key, binding] of Object.entries(node.bindings)) {
		if (!binding?.code?.trim()) continue;
		if (key === 'class' || key === 'className' || key === 'css' || key === '_text') continue;

		const { code, arguments: bindingArgs = ['event'] } = binding;

		if (binding.type === 'spread') {
			const spreadCode = processBinding(code, 'template', options);
			elementString += ` {...(${spreadCode})}`;
		} else if (key === 'ref') {
			// Refs need client-side handling
			const refName = camelCase(code);
			elementString += ` bind:this={${refName}}`;
			needsClientDirective = true;
		} else if (checkIsEvent(key)) {
			// Event handlers
			const eventName = key === 'onChange' && node.name === 'input' ? 'onInput' : key;
			const handlerCode = processBinding(code, 'template', options);
			elementString += ` ${eventName}={${binding.async ? 'async ' : ''}(${bindingArgs.join(',')}) => ${handlerCode}}`;

			if (INTERACTIVE_EVENTS.has(key)) {
				needsClientDirective = true;
			}
		} else if (key === 'innerHTML') {
			const htmlCode = processBinding(code, 'template', options);
			elementString += ` set:html={${htmlCode}}`;
		} else if (key === 'style') {
			const styleCode = processBinding(code, 'template', options);
			elementString += ` style={${styleCode}}`;
		} else {
			// General attribute binding
			const attrCode = processBinding(code, 'template', options);
			elementString += ` ${key}={${attrCode}}`;
		}
	}

	// Add client directive if needed and not disabled
	if (needsClientDirective && options.clientDirective !== 'none') {
		const directive = options.clientDirective || CLIENT_DIRECTIVES.idle;
		elementString += ` ${directive}`;
	}

	// Handle self-closing tags
	if (SELF_CLOSING_HTML_TAGS.has(node.name)) {
		return elementString + ' />';
	}

	elementString += '>';

	// Handle children
	if (node.bindings.innerHTML?.code) {
		// innerHTML takes precedence over children
		const htmlCode = processBinding(node.bindings.innerHTML.code, 'template', options);
		elementString += `{${htmlCode}}`;
	} else if (node.children?.length) {
		const childrenContent = node.children
			.filter(filterEmptyTextNodes)
			.map(child => blockToAstro(child, options))
			.join('\n');
		elementString += childrenContent;
	}

	elementString += `</${node.name}>`;
	return elementString;
}

/**
 * Main Astro v5 component generator
 */
export const componentToAstro: TranspilerGenerator<ToAstroOptions> =
	(userOptions = {}) =>
		({ component }) => {
			// Clone and initialize
			let json = fastClone(component);
			const options = initializeOptions<InternalToAstroOptions>({
				target: 'astro',
				component,
				defaults: {
					typescript: true,
					clientDirective: CLIENT_DIRECTIVES.idle,
					outputFormat: 'astro',
					cssInJs: new Map(),
					clientBoundaryComponents: new Set(),
					...userOptions,
					component: json,
				},
			});

			// Run pre-JSON plugins
			if (options.plugins) {
				json = runPreJsonPlugins({ json, plugins: options.plugins });
			}

			// Analyze component characteristics
			const hydrationAnalysis = analyzeHydrationNeeds(json);
			const hasState = Object.keys(json.state).length > 0;
			const componentHasProps = hasProps(json);
			const refs = getRefs(json);

			// Collect CSS with proper prefix
			const css = collectCss(json, {
				prefix: hash(json),
			});

			// Run post-JSON plugins
			if (options.plugins) {
				json = runPostJsonPlugins({ json, plugins: options.plugins });
			}
			stripMetaProperties(json);

			// Generate frontmatter section
			let frontmatter = '';

			// Add imports
			const imports = renderPreComponent({
				explicitImportFileExtension: options.explicitImportFileExtension,
				component: json,
				target: 'astro',
			});
			if (imports.trim()) {
				frontmatter += imports + '\n\n';
			}

			// Add TypeScript interface for props
			if (options.typescript && componentHasProps) {
				const propsType = json.propsTypeRef || 'Props';
				frontmatter += `interface ${propsType} {\n`;

				if (json.props && Object.keys(json.props).length > 0) {
					Object.entries(json.props).forEach(([propName, propDef]) => {
						const propType = propDef?.propertyType || 'any';
						const optional = propDef?.optional !== false ? '?' : '';
						frontmatter += `  ${propName}${optional}: ${propType};\n`;
					});
				} else {
					frontmatter += `  [key: string]: any;\n`;
				}

				frontmatter += `}\n\n`;
				frontmatter += `const props = Astro.props as ${propsType};\n`;
			} else if (componentHasProps) {
				frontmatter += `const props = Astro.props;\n`;
			}

			// Add state declarations
			if (hasState) {
				frontmatter += '\n// Component state\n';
				Object.entries(json.state).forEach(([key, stateItem]) => {
					if (!stateItem?.code) return;

					const code = stateItem.code;
					const processedCode = processBinding(code, 'frontmatter', options);

					// Detect if it's a function
					const isFunction = typeof code === 'string' && (
						code.includes('function') ||
						code.includes('=>') ||
						/^\s*\([^)]*\)\s*=>/i.test(code)
					);

					if (isFunction) {
						frontmatter += `const ${key} = ${processedCode};\n`;
					} else {
						frontmatter += `let ${key} = ${processedCode};\n`;
					}
				});
			}

			// Add refs
			if (refs.size > 0) {
				frontmatter += '\n// Component refs\n';
				Array.from(refs).forEach(ref => {
					frontmatter += `let ${camelCase(ref)};\n`;
				});
			}

			// Add initialization hooks
			if (json.hooks.onInit?.code) {
				frontmatter += '\n// Component initialization\n';
				frontmatter += processBinding(json.hooks.onInit.code, 'frontmatter', options) + '\n';
			}

			// Generate template
			const template = json.children
				?.filter(filterEmptyTextNodes)
				.map(child => blockToAstro(child, options))
				.join('\n') || '';

			// Generate client-side script for hydration
			let clientScript = '';
			if (hydrationAnalysis.needsHydration) {
				clientScript = '\n<script>\n';

				if (json.hooks.onMount?.length > 0) {
					clientScript += '  // Mount hooks\n';
					json.hooks.onMount.forEach(hook => {
						clientScript += `  ${processBinding(hook.code, 'template', options)};\n`;
					});
				}

				if (json.hooks.onUpdate) {
					clientScript += '  // Update hooks\n';
					json.hooks.onUpdate.forEach(hook => {
						clientScript += `  ${processBinding(hook.code, 'template', options)};\n`;
					});
				}

				clientScript += '</script>';
			}

			// Generate styles
			let styles = '';
			if (css?.trim()) {
				styles += css;
			}

			// Add CSS-in-JS styles
			if (options.cssInJs) {
				options.cssInJs.forEach((cssCode, className) => {
					const cssString = cssObjectToString(cssCode);
					if (cssString.trim()) {
						styles += `.${className} {\n${cssString}}\n\n`;
					}
				});
			}

			if (styles.trim()) {
				styles = `\n<style>\n${styles.trim()}\n</style>`;
			}

			// Assemble final output
			let output = '';

			if (frontmatter.trim()) {
				output += '---\n' + frontmatter.trim() + '\n---\n\n';
			}

			output += template;
			output += clientScript;
			output += styles;

			// Run code plugins
			if (options.plugins) {
				output = runPreCodePlugins({ json, code: output, plugins: options.plugins });
			}

			// Format output
			if (options.prettier !== false) {
				try {
					// Note: Astro formatting would need astro prettier plugin
					// For now, basic HTML formatting
					output = output.replace(/>\s*</g, '>\n<');
				} catch (err) {
					console.warn('Could not format Astro component:', err);
				}
			}

			if (options.plugins) {
				output = runPostCodePlugins({ json, code: output, plugins: options.plugins });
			}

			return output;
		};