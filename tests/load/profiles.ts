export type BenchmarkProfileName = 'quick' | 'stress';
export type BenchmarkOperation = 'read' | 'write';
export type BenchmarkWorkloadName = 'standard' | 'list-heavy' | 'zipfian';

export interface BenchmarkProfile {
    name: BenchmarkProfileName;
    tenants: number;
    widgetsPerTenant: number;
    partsPerWidget: number;
    concurrency: number;
    warmupMs: number;
    durationMs: number;
    readRatio: number;
}

export interface BenchmarkCliOptions {
    profile: BenchmarkProfile;
    preserve: boolean;
    workload: BenchmarkWorkloadName;
}

export const BENCHMARK_PROFILES = {
    quick: {
        name: 'quick',
        tenants: 4,
        widgetsPerTenant: 100,
        partsPerWidget: 2,
        concurrency: 8,
        warmupMs: 3_000,
        durationMs: 10_000,
        readRatio: 0.9,
    },
    stress: {
        name: 'stress',
        tenants: 20,
        widgetsPerTenant: 500,
        partsPerWidget: 2,
        concurrency: 32,
        warmupMs: 15_000,
        durationMs: 60_000,
        readRatio: 0.9,
    },
} as const satisfies Record<BenchmarkProfileName, BenchmarkProfile>;

export function parseBenchmarkArgs(args: string[]): BenchmarkCliOptions {
    let profileName: BenchmarkProfileName = 'quick';
    let preserve = false;
    let workload: BenchmarkWorkloadName = 'standard';

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === undefined) {
            continue;
        }

        if (argument === '--preserve') {
            preserve = true;
            continue;
        }

        if (argument === '--profile') {
            const value = args[index + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new Error(`Missing value for argument: ${argument}`);
            }

            profileName = parseProfileName(value);
            index += 1;
            continue;
        }

        if (argument.startsWith('--profile=')) {
            const value = argument.slice('--profile='.length);
            if (value.length === 0) {
                throw new Error(`Missing value for argument: ${argument}`);
            }

            profileName = parseProfileName(value);
            continue;
        }

        if (argument === '--workload') {
            const value = args[index + 1];
            if (value === undefined || value.startsWith('--')) {
                throw new Error(`Missing value for argument: ${argument}`);
            }

            workload = parseWorkloadName(value);
            index += 1;
            continue;
        }

        if (argument.startsWith('--workload=')) {
            const value = argument.slice('--workload='.length);
            if (value.length === 0) {
                throw new Error(`Missing value for argument: ${argument}`);
            }

            workload = parseWorkloadName(value);
            continue;
        }

        throw new Error(`Unknown benchmark argument: ${argument}`);
    }

    return { profile: BENCHMARK_PROFILES[profileName], preserve, workload };
}

export function selectOperation(sample: number, readRatio = 0.9): BenchmarkOperation {
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
        throw new Error('sample must be between 0 and 1');
    }

    return sample < readRatio ? 'read' : 'write';
}

function parseProfileName(value: string): BenchmarkProfileName {
    if (value === 'quick' || value === 'stress') {
        return value;
    }

    throw new Error(`Unknown benchmark profile: ${value}`);
}

function parseWorkloadName(value: string): BenchmarkWorkloadName {
    if (value === 'standard' || value === 'list-heavy' || value === 'zipfian') {
        return value;
    }

    throw new Error(`Unknown benchmark workload: ${value}`);
}
