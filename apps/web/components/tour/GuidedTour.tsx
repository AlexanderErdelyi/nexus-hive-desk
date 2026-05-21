'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Controls, EventData, TooltipRenderProps } from 'react-joyride';
import type { Step as JoyrideStep } from 'react-joyride';
import { useTour } from './TourContext';
import { tourSteps } from './tourSteps';

const Joyride = dynamic(() => import('react-joyride').then((mod) => mod.Joyride), { ssr: false });

function TourTooltip({ backProps, index, isLastStep, primaryProps, size, skipProps, step, tooltipProps }: TooltipRenderProps) {
  return (
    <div
      {...tooltipProps}
      className="max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs text-gray-400">Step {index + 1} of {size}</span>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-950/80">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${((index + 1) / size) * 100}%` }}
          />
        </div>
      </div>

      {step.title ? <h3 className="mb-2 text-base font-bold text-gray-900 dark:text-white">{step.title as string}</h3> : null}
      <div className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{step.content as string}</div>

      <div className="mt-5 flex gap-1">
        {Array.from({ length: size }).map((_, dotIndex) => (
          <span
            key={dotIndex}
            className={`h-1.5 flex-1 rounded-full ${dotIndex === index ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-700'}`}
          />
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          {...skipProps}
          className="rounded-xl px-3 py-2 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          {index > 0 ? (
            <button
              type="button"
              {...backProps}
              className="rounded-xl px-3 py-2 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              Prev
            </button>
          ) : null}
          <button
            type="button"
            {...primaryProps}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700"
          >
            {isLastStep ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Build joyride steps — if target element not in DOM, fall back to body/center
function resolveSteps(): JoyrideStep[] {
  return tourSteps.map(({ navigate: _nav, ...step }) => {
    const targetMissing =
      typeof step.target === 'string' &&
      step.target !== 'body' &&
      typeof document !== 'undefined' &&
      !document.querySelector(step.target as string);
    if (targetMissing) {
      return { ...step, target: 'body', placement: 'center' } as JoyrideStep;
    }
    return step as JoyrideStep;
  });
}

export function GuidedTour() {
  const router = useRouter();
  const [isMounted, setIsMounted] = useState(false);
  const [steps, setSteps] = useState<JoyrideStep[]>([]);
  const pendingNav = useRef(false);
  const { currentStep, isTourActive, markTourDone, setCurrentStep, stopTour } = useTour();

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => {
    if (!isMounted) return;
    setSteps(resolveSteps());
    const mo = new MutationObserver(() => setSteps(resolveSteps()));
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [isMounted, currentStep]);

  const handleEvent = useCallback((data: EventData, _controls: Controls) => {
    const { action, index, status, type } = data;

    if (status === 'finished' || status === 'skipped') {
      markTourDone();
      stopTour();
      return;
    }

    if (type !== 'step:after' && type !== 'error:target_not_found') return;
    if (pendingNav.current) return;

    const nextIndex = action === 'next' ? index + 1 : action === 'prev' ? Math.max(index - 1, 0) : null;
    if (nextIndex === null) return;

    const nextStep = tourSteps[nextIndex];
    if (!nextStep) return;

    if (nextStep.navigate) {
      pendingNav.current = true;
      router.push(nextStep.navigate);
      setTimeout(() => {
        pendingNav.current = false;
        setCurrentStep(nextIndex);
      }, 400);
    } else {
      setCurrentStep(nextIndex);
    }
  }, [markTourDone, router, setCurrentStep, stopTour]);

  if (!isMounted || !isTourActive) return null;

  return (
    <Joyride
      onEvent={handleEvent}
      run={isTourActive}
      stepIndex={currentStep}
      steps={steps}
      tooltipComponent={TourTooltip}
      options={{
        arrowColor: '#ffffff',
        overlayColor: 'rgba(15, 23, 42, 0.55)',
        primaryColor: '#4f46e5',
        zIndex: 9999,
      }}
    />
  );
}
