#import "FloorExceptionCatcher.h"

NSException * _Nullable FloorCatchException(void (^block)(void)) {
  @try {
    block();
    return nil;
  } @catch (NSException *exception) {
    return exception;
  }
}
