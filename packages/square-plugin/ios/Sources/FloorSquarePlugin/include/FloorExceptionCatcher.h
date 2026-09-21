#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns any thrown NSException (Swift cannot catch these).
NSException * _Nullable FloorCatchException(void (^block)(void));

NS_ASSUME_NONNULL_END
