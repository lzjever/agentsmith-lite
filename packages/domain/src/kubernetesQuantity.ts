import type { SandboxResourceSnapshot } from "../../contracts/src/api.js";

const MAX_QUANTITY=9_223_372_036_854_775_807n;
const MAX_POW10=1_000;
const NUMBER=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;
const QUANTITY=/^(.+?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E|[eE][+-]?\d+)?$/;
const DECIMAL_EXPONENTS:Readonly<Record<string,number>>={n:-9,u:-6,m:-3,"":0,k:3,M:6,G:9,T:12,P:15,E:18};
const BINARY_EXPONENTS:Readonly<Record<string,number>>={Ki:10,Mi:20,Gi:30,Ti:40,Pi:50,Ei:60};
interface Rational{numerator:bigint;denominator:bigint}

export function parseKubernetesCpuMillis(input:string):string{
  const value=parseQuantity(input,"CPU"),scaled=value.numerator*1000n;
  const millis=divideRoundUp(scaled,value.denominator);
  if(millis>MAX_QUANTITY*1000n)throw new Error("Kubernetes CPU quantity exceeds the supported range");
  return millis.toString();
}

export function parseKubernetesMemoryBytes(input:string):string{
  const value=parseQuantity(input,"memory"),bytes=divideRoundUp(value.numerator,value.denominator);
  if(bytes>MAX_QUANTITY)throw new Error("Kubernetes memory quantity exceeds the supported byte range");
  return bytes.toString();
}

export function normalizeSandboxResources(input:{cpuRequest:string;memoryRequest:string;cpuLimit:string;memoryLimit:string}):SandboxResourceSnapshot{return{
  cpuRequestMillis:parseKubernetesCpuMillis(input.cpuRequest),memoryRequestBytes:parseKubernetesMemoryBytes(input.memoryRequest),
  cpuLimitMillis:parseKubernetesCpuMillis(input.cpuLimit),memoryLimitBytes:parseKubernetesMemoryBytes(input.memoryLimit)
}}

export function formatDecimal(value:bigint,scale:number):string{
  if(scale<0||!Number.isSafeInteger(scale))throw new Error("Decimal scale is invalid");
  if(scale===0)return value.toString();
  const negative=value<0n,absolute=negative?-value:value,power=10n**BigInt(scale),whole=absolute/power;
  const fraction=(absolute%power).toString().padStart(scale,"0").replace(/0+$/u,"");
  return `${negative?"-":""}${whole}${fraction?`.${fraction}`:""}`;
}

function parseQuantity(input:string,kind:string):Rational{
  const trimmed=input.trim();if(trimmed.length===0||trimmed.length>128)throw invalid(kind);
  const match=QUANTITY.exec(trimmed),number=match?.[1],suffix=match?.[2]??"";if(!number)throw invalid(kind);
  const parsed=NUMBER.exec(number);if(!parsed||parsed[1]==="-")throw invalid(kind);
  const whole=parsed[2]??"0",fraction=parsed[3]??parsed[4]??"";
  let numerator=BigInt(`${whole}${fraction}`),denominator=pow10(fraction.length,kind);if(numerator===0n)return{numerator:0n,denominator:1n};
  if(Object.hasOwn(BINARY_EXPONENTS,suffix))numerator*=2n**BigInt(BINARY_EXPONENTS[suffix]!);
  else{
    let exponent:number;
    if(/^[eE]/u.test(suffix))exponent=parseExponent(suffix.slice(1),kind);
    else if(Object.hasOwn(DECIMAL_EXPONENTS,suffix))exponent=DECIMAL_EXPONENTS[suffix]!;else throw invalid(kind);
    if(exponent>=0)numerator*=pow10(exponent,kind);else denominator*=pow10(-exponent,kind);
  }
  if(numerator>MAX_QUANTITY*denominator)throw new Error(`Kubernetes ${kind} quantity exceeds the supported range`);
  return{numerator,denominator};
}
function parseExponent(value:string,kind:string):number{if(!/^[+-]?\d+$/u.test(value))throw invalid(kind);const parsed=Number(value);if(!Number.isSafeInteger(parsed)||Math.abs(parsed)>MAX_POW10)throw new Error(`Kubernetes ${kind} quantity exponent exceeds the supported range`);return parsed}
function pow10(exponent:number,kind:string):bigint{if(!Number.isSafeInteger(exponent)||exponent<0||exponent>MAX_POW10)throw new Error(`Kubernetes ${kind} quantity exponent exceeds the supported range`);return 10n**BigInt(exponent)}
function divideRoundUp(numerator:bigint,denominator:bigint):bigint{return numerator===0n?0n:(numerator+denominator-1n)/denominator}
function invalid(kind:string):Error{return new Error(`Kubernetes ${kind} quantity is invalid`)}
