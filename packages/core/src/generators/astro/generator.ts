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
import { format } from 'prettier/standalone';
import { ToAstroOptions } from './types';

// Implement proper class string collection for Astro
const collectClassString = (json: MitosisNode, options: InternalToAstroOptions): string => {
	const classes: string[] = [];

	// Handle static class/className properties
	if (json.properties.class) {
		classes.push(`"${json.properties.class}"`);
	}
	if (json.properties.className) {
		classes.push(`"${json.properties.className}"`);
	}

	// Handle dynamic class bindings
	if (json.bindings.class?.code) {
		const classCode = processBinding(options.component, json.bindings.class.code, 'template');
		classes.push(`${classCode}`);
	}
	if (json.bindings.className?.code) {
		const classCode = processBinding(options.component, json.bindings.className.code, 'template');
		classes.push(`${classCode}`);
	}

	// Handle CSS-in-JS (css prop)
	if (json.bindings.css?.code) {
		// Generate a scoped class name for CSS-in-JS
		const cssHash = hash(json.bindings.css.code);
		const scopedClassName = `${json.name}-${cssHash}`;
		classes.push(`"${scopedClassName}"`);

		// Store CSS-in-JS for later processing in styles
		if (!options.cssInJs) options.cssInJs = new Map();
		options.cssInJs.set(scopedClassName, json.bindings.css.code);
	}

	if (classes.length === 0) return '';

	// If only one class and it's a simple string, return it directly
	if (classes.length === 1 && classes[0].startsWith('"') && classes[0].endsWith('"')) {
		return classes[0];
	}

	// Multiple classes or dynamic classes need expression syntax
	return `{[${classes.join(', ')}].filter(Boolean).join(' ')}`;
};

interface InternalToAstroOptions extends ToAstroOptions {
	component: MitosisComponent;
	cssInJs?: Map<string, string>; // Store CSS-in-JS styles
}

// Map of Mitosis events to Astro client directives
const HYDRATION_EVENTS = new Set([
	'onClick', 'onChange', 'onInput', 'onSubmit', 'onFocus', 'onBlur',
	'onMouseOver', 'onMouseOut', 'onKeyDown', 'onKeyUp', 'onScroll',
]);

// Check if component needs client-side hydration
function needsHydration(json: MitosisComponent): boolean {
	let needsClient = false;

	// Check for refs (always need hydration)
	const refs = getRefs(json);
	if (refs.size > 0) needsClient = true;

	// Check for interactive hooks
	if (json.hooks.onMount.length > 0) needsClient = true;
	if (json.hooks.onUpdate) needsClient = true;

	// Check for event handlers in the tree
	function checkNodeForEvents(node: MitosisNode): boolean {
		for (const key in node.bindings) {
			if (checkIsEvent(key)) return true;
		}
		return node.children.some(checkNodeForEvents);
	}

	if (json.children.some(checkNodeForEvents)) needsClient = true;

	return needsClient;
}

// Process bindings for Astro context (frontmatter vs template)
function processBinding(
	json: MitosisComponent,
	code: string,
	context: 'frontmatter' | 'template' = 'template',
): string {
	try {
		// In frontmatter, state and props are direct variables
		// In template, they need to be referenced appropriately
		let processed = code;

		if (context === 'template') {
			// Replace state.foo with just foo in template expressions
			processed = processed.replace(/\bstate\.(\w+)/g, '$1');
			// Replace props.foo with just foo in template expressions
			processed = processed.replace(/\bprops\.(\w+)/g, '$1');
		} else if (context === 'frontmatter') {
			// In frontmatter, keep state references but make them proper variable declarations
			processed = processed.replace(/\bstate\.(\w+)/g, '$1');
			processed = processed.replace(/\bprops\.(\w+)/g, 'props.$1');
		}

		return processed;
	} catch (error) {
		console.error('Astro: could not process binding', code);
		return code;
	}
}

// Convert CSS-in-JS object to CSS string
function cssObjectToString(cssCode: string): string {
	try {
		// This is a simplified CSS-in-JS parser
		// In a real implementation, you'd want to use a proper CSS-in-JS parser
		const cssObj = new Function('return ' + cssCode)();

		let cssString = '';
		for (const [property, value] of Object.entries(cssObj)) {
			const cssProperty = property.replace(/([A-Z])/g, '-$1').toLowerCase();
			cssString += `  ${cssProperty}: ${value};\n`;
		}

		return cssString;
	} catch (error) {
		console.warn('Could not parse CSS-in-JS:', cssCode);
		return '';
	}
}

// Convert Mitosis node to Astro template
const blockToAstro = (json: MitosisNode, options: InternalToAstroOptions): string => {
	// Handle text nodes
	if (json.properties._text) {
		return json.properties._text;
	}
	if (json.bindings._text?.code) {
		return `{${processBinding(options.component, json.bindings._text.code, 'template')}}`;
	}

	// Handle Fragment
	if (json.name === 'Fragment') {
		return json.children.map((child) => blockToAstro(child, options)).join('\n');
	}

	// Handle For loops
	if (checkIsForNode(json)) {
		const forArguments = getForArguments(json);
		const [itemName, indexName] = forArguments;
		const eachCode = processBinding(options.component, json.bindings.each?.code as string, 'template');

		return `{${eachCode}.map((${itemName}${indexName ? `, ${indexName}` : ''}) => (
      ${json.children
			.filter(filterEmptyTextNodes)
			.map((item) => blockToAstro(item, options))
			.join('\n')}
    ))}`;
	}

	// Handle Show conditionals
	if (json.name === 'Show') {
		const whenCode = processBinding(options.component, json.bindings.when?.code as string, 'template');
		const elseBlock = json.meta.else ? blockToAstro(json.meta.else as MitosisNode, options) : '';

		return `{${whenCode} ? (
      ${json.children
			.filter(filterEmptyTextNodes)
			.map((item) => blockToAstro(item, options))
			.join('\n')}
    ) : ${elseBlock ? `(${elseBlock})` : 'null'}}`;
	}

	let str = `<${json.name}`;

	// Handle class/className with proper collection
	const classString = collectClassString(json, options);
	if (classString) {
		str += ` class=${classString}`;
	}

	// Handle properties (excluding class/className as they're handled above)
	for (const key in json.properties) {
		if (key === 'class' || key === 'className') continue;
		const value = json.properties[key];
		str += ` ${key}="${value}"`;
	}

	// Handle bindings
	let hasClientDirective = false;
	for (const key in json.bindings) {
		if (key === 'class' || key === 'className' || key === 'css') continue; // Handled above

		const { code, arguments: cusArgs = ['event'], type, async } = json.bindings[key]!;
		if (!code) continue;

		if (type === 'spread') {
			str += ` {...(${processBinding(options.component, code, 'template')})}`;
		} else if (key === 'ref') {
			// Refs need client-side hydration
			str += ` bind:this={${camelCase(code)}}`;
			hasClientDirective = true;
		} else if (checkIsEvent(key)) {
			// Event handlers need client-side hydration
			const useKey = key === 'onChange' && json.name === 'input' ? 'onInput' : key;
			const asyncKeyword = async ? 'async ' : '';
			str += ` ${useKey}={${asyncKeyword}(${cusArgs.join(',')}) => ${processBinding(options.component, code, 'template')}}`;

			if (HYDRATION_EVENTS.has(key)) {
				hasClientDirective = true;
			}
		} else if (key === 'innerHTML') {
			str += ` set:html={${processBinding(options.component, code, 'template')}}`;
		} else if (key === 'style') {
			// Handle style objects by converting camelCase to kebab-case
			const styleCode = babelTransformExpression(code, {
				ObjectExpression(path: any) {
					for (const property of path.node.properties) {
						if (property.key?.name) {
							property.key.value = kebabCase(property.key.name);
							property.key.type = 'StringLiteral';
						}
					}
				},
			});
			str += ` style={${processBinding(options.component, styleCode, 'template')}}`;
		} else {
			str += ` ${key}={${processBinding(options.component, code, 'template')}}`;
		}
	}

	// Add client directive if needed
	if (hasClientDirective && options.clientDirective !== 'none') {
		const directive = options.clientDirective || 'client:load';
		str += ` ${directive}`;
	}

	// Handle self-closing tags
	if (SELF_CLOSING_HTML_TAGS.has(json.name)) {
		return str + ' />';
	}

	str += '>';

	// Handle innerHTML separately
	if (json.bindings.innerHTML?.code) {
		str += `{${processBinding(options.component, json.bindings.innerHTML.code, 'template')}}`;
	} else if (json.children) {
		str += json.children
			.filter(filterEmptyTextNodes)
			.map((item) => blockToAstro(item, options))
			.join('\n');
	}

	str += `</${json.name}>`;
	return str;
};

export const componentToAstro: TranspilerGenerator<ToAstroOptions> =
	(userOptions = {}) =>
		({ component }) => {
			let json = fastClone(component);
			const options = initializeOptions<InternalToAstroOptions>({
				target: 'astro',
				component,
				defaults: {
					typescript: true,
					clientDirective: 'client:load',
					cssInJs: new Map(),
					...userOptions,
					component: json,
				},
			});

			// Run pre-plugins
			if (options.plugins) {
				json = runPreJsonPlugins({ json, plugins: options.plugins });
			}

			// Collect CSS
			const css = collectCss(json, {
				prefix: hash(json),
			});

			// Get component data
			const hasState = Object.keys(json.state).length > 0;
			const componentHasProps = hasProps(json);
			const refs = getRefs(json);
			const needsClient = needsHydration(json);

			// Run post-plugins
			if (options.plugins) {
				json = runPostJsonPlugins({ json, plugins: options.plugins });
			}
			stripMetaProperties(json);

			// Generate frontmatter
			let frontmatterContent = '';

			// Add imports
			const imports = renderPreComponent({
				explicitImportFileExtension: options.explicitImportFileExtension,
				component: json,
				target: 'astro',
			});

			if (imports.trim()) {
				frontmatterContent += imports + '\n\n';
			}

			// Add props interface if TypeScript is enabled
			if (options.typescript && componentHasProps) {
				const propsType = json.propsTypeRef || 'Props';
				frontmatterContent += `interface ${propsType} {\n`;
				// Generate prop types based on actual usage - simplified for now
				Object.keys(json.props || {}).forEach(prop => {
					frontmatterContent += `  ${prop}?: any;\n`;
				});
				frontmatterContent += `}\n\n`;

				frontmatterContent += `const props = Astro.props as ${propsType};\n`;
			} else if (componentHasProps) {
				frontmatterContent += `const props = Astro.props;\n`;
			}

			// Add state variables (proper JS declarations)
			if (hasState) {
				frontmatterContent += '\n// Component state\n';
				Object.entries(json.state).forEach(([key, value]) => {
					if (typeof value?.code === 'string') {
						// Handle function state
						if (value.code.includes('function') || value.code.includes('=>')) {
							frontmatterContent += `const ${key} = ${processBinding(json, value.code, 'frontmatter')};\n`;
						} else {
							// Handle primitive state
							frontmatterContent += `let ${key} = ${processBinding(json, value.code, 'frontmatter')};\n`;
						}
					} else if (value?.code !== undefined) {
						// Handle non-string values
						frontmatterContent += `let ${key} = ${JSON.stringify(value.code)};\n`;
					}
				});
			}

			// Add refs
			if (refs.size > 0) {
				frontmatterContent += '\n// Component refs\n';
				Array.from(refs).forEach(ref => {
					const refName = camelCase(ref);
					frontmatterContent += `let ${refName};\n`;
				});
			}

			// Add lifecycle hooks for server-side
			if (json.hooks.onInit?.code) {
				frontmatterContent += `\n// Component initialization\n${processBinding(json, json.hooks.onInit.code, 'frontmatter')}\n`;
			}

			// Generate template
			let templateContent = json.children
				.filter(filterEmptyTextNodes)
				.map((item) => blockToAstro(item, options))
				.join('\n');

			// Add client-side script for interactivity
			let clientScript = '';
			if (needsClient && (json.hooks.onMount || json.hooks.onUpdate || refs.size > 0)) {
				clientScript = '\n<script>\n';

				// Add onMount hooks
				if (json.hooks.onMount.length > 0) {
					clientScript += '  // Component mounted\n';
					json.hooks.onMount.forEach(hook => {
						clientScript += `  ${processBinding(json, hook.code, 'template')}\n`;
					});
				}

				// Add onUpdate hooks (converted to event listeners or observers)
				if (json.hooks.onUpdate) {
					clientScript += '  // Update hooks\n';
					json.hooks.onUpdate.forEach(hook => {
						clientScript += `  ${processBinding(json, hook.code, 'template')}\n`;
					});
				}

				clientScript += '</script>';
			}

			// Generate styles (including CSS-in-JS)
			let styleContent = '';
			if (css && css.trim().length > 0) {
				styleContent = css;
			}

			// Add CSS-in-JS styles
			if (options.cssInJs && options.cssInJs.size > 0) {
				options.cssInJs.forEach((cssCode, className) => {
					const cssString = cssObjectToString(cssCode);
					if (cssString) {
						styleContent += `.${className} {\n${cssString}}\n\n`;
					}
				});
			}

			// Wrap styles if we have any
			if (styleContent.trim()) {
				styleContent = `\n<style>\n${styleContent.trim()}\n</style>`;
			}

			// Combine everything
			let finalContent = '';

			// Add frontmatter if we have any
			if (frontmatterContent.trim()) {
				finalContent += '---\n' + frontmatterContent.trim() + '\n---\n\n';
			}

			// Add template
			finalContent += templateContent;

			// Add client script
			finalContent += clientScript;

			// Add styles
			finalContent += styleContent;

			// Run pre-code plugins
			if (options.plugins) {
				finalContent = runPreCodePlugins({ json, code: finalContent, plugins: options.plugins });
			}

			// Format with Prettier for .astro files
			if (options.prettier !== false) {
				try {
					finalContent = format(finalContent, {
						parser: 'html',
						plugins: [
							require('prettier/parser-html'),
							require('prettier/parser-typescript'),
							require('prettier/parser-postcss'),
						],
					});
				} catch (err) {
					console.warn('Could not format Astro component', err);
				}
			}

			// Run post-code plugins
			if (options.plugins) {
				finalContent = runPostCodePlugins({ json, code: finalContent, plugins: options.plugins });
			}

			return finalContent;
		};