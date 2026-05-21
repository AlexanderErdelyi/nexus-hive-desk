'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const TOUR_DONE_STORAGE_KEY = 'nhd_tour_done';

interface TourContextValue {
  startTour: (startStep?: number) => void;
  stopTour: () => void;
  isTourActive: boolean;
  currentStep: number;
  setCurrentStep: (step: number) => void;
  hasCompletedTour: boolean;
  markTourDone: () => void;
}

const TourContext = createContext<TourContextValue | undefined>(undefined);

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [isTourActive, setIsTourActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [hasCompletedTour, setHasCompletedTour] = useState(false);

  useEffect(() => {
    try {
      const isDone = window.localStorage.getItem(TOUR_DONE_STORAGE_KEY) === 'true';
      setHasCompletedTour(isDone);
      if (!isDone) {
        setIsTourActive(true);
      }
    } catch {
      setHasCompletedTour(false);
      setIsTourActive(true);
    }
  }, []);

  const startTour = useCallback((startStep = 0) => {
    setCurrentStep(startStep);
    setIsTourActive(true);
  }, []);

  const stopTour = useCallback(() => {
    setIsTourActive(false);
    setCurrentStep(0);
  }, []);

  const markTourDone = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_DONE_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage errors and keep the tour usable.
    }
    setHasCompletedTour(true);
  }, []);

  const value = useMemo(
    () => ({
      startTour,
      stopTour,
      isTourActive,
      currentStep,
      setCurrentStep,
      hasCompletedTour,
      markTourDone,
    }),
    [currentStep, hasCompletedTour, isTourActive, markTourDone, startTour, stopTour]
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour() {
  const context = useContext(TourContext);

  if (!context) {
    throw new Error('useTour must be used within a TourProvider');
  }

  return context;
}
