'use client';

import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventData, Step as JoyrideStep, TooltipRenderProps } from 'react-joyride';
import { useTour } from './TourContext';
import { type TourStep, tourSteps } from './tourSteps';

const Joyride = dynamic(() => import('react-joyride').then((mod) => mod.Joyride), { ssr: false });

function TourTooltip({ backProps, index, isLastStep, primaryProps, size, skipProps, step, tooltipProps }: TooltipRenderProps) {
  return (
    <div
      {...tooltipProps}
      className="max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs text-gray-400">Step {index + 1} of {size}</span>
        <div className="h-1.5 w-10 rounded-full bg-indigo-100 dark:bg-indigo-950/80">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${((index + 1) / size) * 100}%` }}
          />
        </div>
      </div>

      {step.title ? <h3 className="mb-2 text-base font-bold text-gray-900 dark:text-white">{step.title}</h3> : null}
      <div className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">{step.content}</div>

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
          Skip
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

function resolveStep(step: TourStep): JoyrideStep {
  const resolvedStep =
    typeof document === 'undefined' || typeof step.target !== 'string' || step.target === 'body' || document.querySelector(step.target)
      ? step
      : {
          ...step,
          target: 'body',
          placement: 'center',
          disableScrolling: true,
        };

  const { disableScrolling, navigate: _navigate, ...joyrideStep } = resolvedStep;
  const normalizedStep = (disableScrolling ? { ...joyrideStep, skipScroll: true } : joyrideStep) as JoyrideStep;

  return normalizedStep;
}

export function GuidedTour() {
  const pathname = usePathname();
  const router = useRouter();
  const [isMounted, setIsMounted] = useState(false);
  const [domVersion, setDomVersion] = useState(0);
  const timeoutRef = useRef<number | null>(null);
  const { currentStep, isTourActive, markTourDone, setCurrentStep, stopTour } = useTour();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isMounted || !isTourActive) {
      return;
    }

    const observer = new MutationObserver(() => {
      setDomVersion((value) => value + 1);
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    return () => observer.disconnect();
  }, [isMounted, isTourActive]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const steps = useMemo(() => tourSteps.map(resolveStep), [domVersion, pathname]);

  const queueStepChange = (nextStepIndex: number) => {
    const nextStep = tourSteps[nextStepIndex];

    if (!nextStep) {
      return;
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }

    if (nextStep.navigate && nextStep.navigate !== pathname) {
      router.push(nextStep.navigate);
      timeoutRef.current = window.setTimeout(() => {
        setCurrentStep(nextStepIndex);
        timeoutRef.current = null;
      }, 300);
      return;
    }

    setCurrentStep(nextStepIndex);
  };

  const handleEvent = (data: EventData) => {
    if (data.status === 'finished' || data.status === 'skipped') {
      markTourDone();
      stopTour();
      return;
    }

    if (data.type !== 'step:after' && data.type !== 'error:target_not_found') {
      return;
    }

    if (data.action === 'next') {
      queueStepChange(data.index + 1);
      return;
    }

    if (data.action === 'prev') {
      queueStepChange(Math.max(data.index - 1, 0));
    }
  };

  if (!isMounted) {
    return null;
  }

  return (
    <Joyride
      continuous
      onEvent={handleEvent}
      run={isTourActive}
      stepIndex={currentStep}
      steps={steps}
      options={{
        arrowColor: '#ffffff',
        buttons: ['skip', 'back', 'primary'],
        overlayColor: 'rgba(15, 23, 42, 0.55)',
        primaryColor: '#4f46e5',
        zIndex: 60,
      }}
      tooltipComponent={TourTooltip}
    />
  );
}
