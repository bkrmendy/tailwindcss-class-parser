import {segment} from "./utils/segment";
import {findRoot} from "./find-root";
import {type FunctionalPlugin, functionalPlugins, namedPlugins, type Variant} from "./plugins";
import {parseVariant} from "./parse-variant";
import {inferDataType} from "./utils/infer-data-type";
import {getValue, type Value} from "./utils/value";
import type {Config, ScreensConfig} from "tailwindcss/types/config";
import {getTailwindTheme} from "./theme";
import {CalculateHexFromString} from "./utils/calculate-hex-from-string";
import {findTailwindColorFromHex} from "./utils/find-tailwind-color-from-hex";
import {buildModifier} from "./utils/build-modifier";
import {isColor} from "./utils/is-color";
import {decodeArbitraryValue} from "./utils/decodeArbitraryValue";

export type State = {
    important: boolean
    negative: boolean
}

export type AST = {
    root: string
    kind: "named" | "functional"
    property: string
    value: string
    valueDef: Value
    variants: Variant[]
    modifier: string | null,
    important: boolean
    negative: boolean,
    arbitrary: boolean
}

export type Error = {
    root: string
    kind: "error"
    message: string
}

export const parse = (input: string, config?: Config): AST | Error => {
    if(!input) {
        return {
            root: "",
            kind: "error",
            message: "Empty input"
        }
    }

    const theme = getTailwindTheme(config)
    let state: State = {
        important: false,
        negative: false
    }
    const variants = segment(input, ':')
    let base = variants.pop()!

    let parsedCandidateVariants: Variant[] = []

    for (let i = variants.length - 1; i >= 0; --i) {
        let parsedVariant = parseVariant(variants[i], theme.screens as ScreensConfig)
        if (parsedVariant !== null)
            parsedCandidateVariants.push(parsedVariant)
    }

    if (base[0] === '!') {
        state.important = true
        base = base.slice(1)
    }

    if (base[0] === '-') {
        state.negative = true
        base = base.slice(1)
    }

    const namedPlugin = namedPlugins.get(base)
    if (namedPlugin) {
        return {
            root: base,
            kind: "named",
            property: namedPlugin!.ns,
            value: namedPlugin.value,
            valueDef: {
                class: namedPlugin.class,
                raw: base,
                kind: "named",
                value: namedPlugin.value,
            },
            variants: parsedCandidateVariants,
            modifier: null,
            important: state.important,
            negative: state.negative,
            arbitrary: false
        }
    }

    let [root, value] = findRoot(base, functionalPlugins)

    if (!root) {
        //throw new PluginNotFoundException(base)
        return {
            root: base,
            kind: "error",
            message: "Tailwindcss core plugin not found",
        }
    }

    const availablePlugins = functionalPlugins.get(root) as FunctionalPlugin[]
    let modifier: string | null = null
    let [valueWithoutModifier, modifierSegment = null] = segment(value || "", '/')
    if (modifierSegment && isColor(valueWithoutModifier.replace(/[\[\]]/g, ""), theme)) {
        modifier = buildModifier(modifierSegment, theme.opacity)
    }

    if (valueWithoutModifier && valueWithoutModifier[0] === '[' && valueWithoutModifier[valueWithoutModifier.length - 1] === ']') {
        let arbitraryValue = valueWithoutModifier.slice(1, -1)
        const unitType = inferDataType(arbitraryValue, [...availablePlugins.values()].map(({type}) => type))
        let associatedPluginByType = availablePlugins!.find(plugin => plugin.type === unitType)

        if (unitType === "color") {
            const color = CalculateHexFromString(arbitraryValue)
            if(!color){
                return {
                    root: base,
                    kind: "error",
                    message: "Color is not correct",
                }
            }
            valueWithoutModifier = findTailwindColorFromHex(color.hex, theme[associatedPluginByType?.scaleKey || "colors"]) || color.hex
        }else{
            //It's not color, but it's still an arbitrary. We are just going to do parse it
            //The result might not be correct, but it's better than nothing and even tailwind will parse it anyway
            if(availablePlugins.length > 0){
                associatedPluginByType = availablePlugins.find(x => x.type === unitType) || availablePlugins.find(x => x.type !== "color")
            }
        }

        arbitraryValue = decodeArbitraryValue(arbitraryValue)

        return {
            root: root,
            kind: "functional",
            property: associatedPluginByType!.ns,
            value: arbitraryValue,
            valueDef: {
                value: arbitraryValue,
                class: associatedPluginByType!.class,
                raw: valueWithoutModifier,
                kind: unitType || "named"
            },
            variants: parsedCandidateVariants,
            modifier: modifier,
            arbitrary: true,
            important: state.important,
            negative: state.negative
        }
    }

    if (!value) {
        value = 'DEFAULT'
    }

    //check value against each scale of available plugins
    let matchedPlugin = availablePlugins.find(({scaleKey}) => value.split('-')[0] in theme[scaleKey] || valueWithoutModifier in theme[scaleKey])
    if (!matchedPlugin) {
        return {
            root: base,
            kind: "error",
            message: `found "${availablePlugins.map(x => x.ns).join(', ')}" plugins but unable to determine which one is matched to given value "${value}".`,
        }
    }

    const val = getValue(matchedPlugin.type === "color" ? valueWithoutModifier : value, matchedPlugin, theme[matchedPlugin.scaleKey])

    return {
        root: root,
        kind: "functional",
        property: matchedPlugin.ns,
        value: val.value,
        valueDef: val,
        variants: parsedCandidateVariants,
        modifier: modifier,
        important: state.important,
        negative: state.negative,
        arbitrary: false,
    }
}